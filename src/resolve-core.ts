/* eslint-disable max-lines */

import { canonicalizeKey, toEnvName, toFlagName } from './keys.js';
import { EnvironmentalistError } from './errors.js';
import {
  applyEnvironmentOverrides,
  coerceValue,
  hasAncestorWinner,
  hasDescendantWinner,
  loadSources,
  loadSourcesSync,
  pathsRelate,
  setValueAtPath,
} from './coerce.js';
import type { LoadedSource, ResolutionCandidate } from './coerce.js';
import type { z } from 'zod';
import type {
  EnvironmentalistOptions,
  Provenance,
  ResolutionTrace,
  Source,
  SourceContext,
} from './types.js';

type SchemaRecord = Record<string, unknown>;

/** Metadata-driven overrides and secret keys supplied by the validation track. */
export type ResolveExtras = {
  readonly secretKeys?: ReadonlySet<string>;
  readonly envOverrides?: Readonly<Record<string, string>>;
  readonly flagOverrides?: Readonly<Record<string, string>>;
};

/** The neutral options consumed by the merge, coercion, and trace engine. */
export type ResolveCoreOptions = {
  readonly name: string;
  readonly cwd: string;
  readonly envPrefix?: string;
  readonly coerce?: boolean;
  readonly onResolve?: (trace: ResolutionTrace) => void;
};

/** The unvalidated, canonical result produced by the resolution engine. */
export type ResolvedRaw = {
  readonly values: Record<string, unknown>;
  readonly provenance: Record<string, Provenance>;
  readonly trace: ResolutionTrace;
  readonly checked: Record<string, readonly string[]>;
  /** True when schema defaults are absent and validation should remove default wrappers. */
  readonly defaultsExcluded: boolean;
};

function isRecord(value: unknown): value is SchemaRecord {
  return typeof value === 'object' && value !== null;
}

function definition(schema: unknown): SchemaRecord | undefined {
  if (!isRecord(schema)) return undefined;
  const zod = schema['_zod'];
  if (isRecord(zod) && isRecord(zod['def'])) return zod['def'];
  if (isRecord(schema['def'])) return schema['def'];
  if (isRecord(schema['_def'])) return schema['_def'];
  return undefined;
}

function schemaType(schema: unknown): string | undefined {
  const type = definition(schema)?.['type'];
  return typeof type === 'string' ? type : undefined;
}

function schemaChildren(schema: unknown): readonly unknown[] {
  const def = definition(schema);
  if (def === undefined) return [];
  const children: unknown[] = [];
  for (const key of [
    'innerType',
    'element',
    'rest',
    'left',
    'right',
    'in',
    'out',
    'keyType',
    'valueType',
    'catchall',
  ]) {
    if (def[key] !== undefined) children.push(def[key]);
  }
  for (const key of ['items', 'options']) {
    const value = def[key];
    if (Array.isArray(value)) children.push(...value);
  }
  return children;
}

function unwrap(schema: unknown): unknown {
  let current = schema;
  const seen = new Set<unknown>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const def = definition(current);
    if (def === undefined) return current;
    const type = def['type'];
    if (
      (type === 'optional' || type === 'nullable' || type === 'default' || type === 'catch') &&
      def['innerType'] !== undefined
    ) {
      current = def['innerType'];
      continue;
    }
    return current;
  }
  return current;
}

/** Read the shape of a Zod object through the stable v4 definition fields. */
export function schemaShape(schema: unknown): Record<string, unknown> | undefined {
  const def = definition(unwrap(schema));
  return def?.['type'] === 'object' && isRecord(def['shape']) ? def['shape'] : undefined;
}

// eslint-disable-next-line complexity
function defaultForSchema(schema: unknown): { readonly found: boolean; readonly value?: unknown } {
  let current = schema;
  const seen = new Set<unknown>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const def = definition(current);
    if (def === undefined) return { found: false };
    if (def['type'] === 'default' && 'defaultValue' in def) {
      const value = def['defaultValue'];
      return { found: true, value: typeof value === 'function' ? value() : value };
    }
    if (
      (def['type'] === 'optional' || def['type'] === 'nullable' || def['type'] === 'catch') &&
      def['innerType'] !== undefined
    ) {
      current = def['innerType'];
      continue;
    }
    return { found: false };
  }
  return { found: false };
}

/** Return canonical top-level schema defaults for the defaults source. */
export function schemaDefaults(schema: z.ZodObject): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schemaShape(schema) ?? {})) {
    const result = defaultForSchema(field);
    if (result.found) values[canonicalizeKey(key)] = result.value;
  }
  return values;
}

/** Create the neutral source that supplies Zod schema defaults. */
export function createDefaultsSource(schema: z.ZodObject): Source {
  const load = () => {
    const values = schemaDefaults(schema);
    return Object.keys(values).length === 0 ? undefined : { values, location: 'schema defaults' };
  };
  return { id: 'defaults', kind: 'typed', load, loadSync: load };
}

/** Return a schema field at a canonical dotted path. */
export function schemaAtPath(schema: z.ZodObject, path: string): unknown {
  let current: unknown = schema;
  for (const segment of path.split('.')) {
    const shape = schemaShape(current);
    if (shape === undefined) return undefined;
    const entry = Object.entries(shape).find(([key]) => canonicalizeKey(key) === segment);
    current = entry?.[1];
  }
  return current;
}

/**
 * Report whether the field at a canonical path declares a Zod default.
 *
 * @param schema - The caller's schema.
 * @param path - A canonical dotted path.
 * @returns True when the field would have had a default to fall back on.
 */
export function hasSchemaDefault(schema: z.ZodObject, path: string): boolean {
  return defaultForSchema(schemaAtPath(schema, path)).found;
}

function nestedSchemaPaths(schema: unknown, prefix = ''): string[] {
  const shape = schemaShape(schema);
  if (shape === undefined) return prefix.length === 0 ? [] : [prefix];
  const paths: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    const path = prefix.length === 0 ? canonicalizeKey(key) : `${prefix}.${canonicalizeKey(key)}`;
    const childPaths = nestedSchemaPaths(field, path);
    paths.push(...(childPaths.length === 0 ? [path] : childPaths));
  }
  return paths;
}

/** Return canonical leaf paths used for field-level coercion and tracing. */
export function schemaLeafPaths(schema: z.ZodObject): readonly string[] {
  return nestedSchemaPaths(schema);
}

/** Return canonical top-level keys from a schema. */
export function schemaTopLevelKeys(schema: z.ZodObject): readonly string[] {
  return Object.keys(schemaShape(schema) ?? {}).map(canonicalizeKey);
}

/** Minimal options needed to render a human-readable source spelling. */
export type SourceLabelOptions = {
  readonly name: string;
  readonly cwd?: string;
  readonly envPrefix?: string;
};

/** Exact-name overrides used when rendering checked source spellings. */
export type SourceLabelExtras = {
  readonly envOverrides?: Readonly<Record<string, string>>;
  readonly flagOverrides?: Readonly<Record<string, string>>;
};

/** Render the human-readable spelling consulted for one source and key. */
export function sourceLabel(
  source: Source,
  key: string,
  options: SourceLabelOptions,
  extras: SourceLabelExtras,
): string {
  const flagOverride = Object.entries(extras.flagOverrides ?? {}).find(
    ([canonical]) => canonicalizeKey(canonical) === key,
  )?.[1];
  const labels: Record<string, string> = {
    flags: `flag --${toFlagName(flagOverride ?? key)}`,
    'search-params': `search ?${toFlagName(key)}`,
    env: `env ${extras.envOverrides?.[key] ?? toEnvName(key, options.envPrefix)}`,
    dotenv: '.env',
    'project-config': `${options.name}.config.* (up from ${options.cwd ?? '/'})`,
    'package-json': 'package.json',
    'user-dotfile': `~/.${options.name}`,
    'xdg-config': `~/.config/${options.name}/config.*`,
    'home-config': `~/.environmentalist/${options.name}`,
    'injected-global': `globalThis.__${options.name}__`,
    'local-storage': `localStorage:environmentalist:${options.name}`,
    'import-meta-env': 'import.meta.env',
    defaults: 'schema defaults',
  };
  return labels[source.id] ?? `source ${source.id}`;
}

// eslint-disable-next-line complexity
function guardSchemaNode(schema: unknown, path: string, visited: Set<unknown>): void {
  if (schema === undefined || visited.has(schema)) return;
  visited.add(schema);
  const def = definition(schema);
  if (def === undefined) return;

  if (def['type'] === 'object') {
    const catchall = def['catchall'];
    if (catchall !== undefined && schemaType(catchall) !== 'never') {
      throw new EnvironmentalistError(
        `Schema at ${path || 'root'} uses passthrough/catchall object fields, which Environmentalist cannot safely camel-case.`,
      );
    }
    const shape = schemaShape(schema) ?? {};
    const canonicalNames = new Map<string, string>();
    for (const [originalKey, child] of Object.entries(shape)) {
      const canonical = canonicalizeKey(originalKey);
      const previous = canonicalNames.get(canonical);
      if (previous !== undefined) {
        throw new EnvironmentalistError(
          `Schema keys "${previous}" and "${originalKey}" collide as canonical key "${canonical}"${path ? ` at ${path}` : ''}.`,
        );
      }
      canonicalNames.set(canonical, originalKey);
      guardSchemaNode(child, path ? `${path}.${canonical}` : canonical, visited);
    }
  }

  for (const child of schemaChildren(schema)) guardSchemaNode(child, path, visited);
}

/**
 * Reject the required options before any source consults the filesystem.
 *
 * `name` seeds config-file, dotfile, and home-directory path joins, so a
 * missing one used to surface as a `paths[1]` `TypeError` from deep inside
 * `node:path` rather than as a statement about the contract.
 *
 * @param options - The name and schema a caller supplied, unvalidated.
 * @throws {@link EnvironmentalistError} when either is missing or the wrong shape.
 */
export function guardRequiredOptions(options: { name?: unknown; schema?: unknown }): void {
  if (typeof options.name !== 'string' || options.name.trim().length === 0) {
    throw new EnvironmentalistError(
      'options.name is required: it names the config files, dotfiles, and environment variables Environmentalist looks for.',
    );
  }
  if (schemaShape(options.schema) === undefined) {
    throw new EnvironmentalistError(
      `options.schema is required for "${options.name}" and must be a Zod object schema.`,
    );
  }
}

/** Run construction-time collision and unsupported-object guards on a schema. */
export function guardSchema(schema: z.ZodObject, name: string): void {
  try {
    guardSchemaNode(schema, '', new Set<unknown>());
  } catch (error) {
    if (error instanceof EnvironmentalistError) {
      throw new EnvironmentalistError(`Invalid schema for "${name}": ${error.message}`);
    }
    throw error;
  }
}

function sourceContains(candidates: readonly ResolutionCandidate[], path: string): boolean {
  return candidates.some((candidate) => pathsRelate(candidate.path, path));
}

// eslint-disable-next-line complexity
function resolveLoaded(
  schema: z.ZodObject,
  options: ResolveCoreOptions,
  context: SourceContext,
  sources: readonly Source[],
  loaded: readonly LoadedSource[],
  extras: ResolveExtras,
): ResolvedRaw {
  const values: Record<string, unknown> = {};
  const provenance: Record<string, Provenance> = {};
  const winners = new Map<string, Provenance>();
  const coerce = options.coerce !== false;

  for (const entry of loaded) {
    const layer: Provenance = { source: entry.source.id, location: entry.result.location };
    for (const candidate of entry.candidates) {
      if (candidate.value === undefined || hasAncestorWinner(candidate.path, winners)) continue;
      if (winners.has(candidate.path) || hasDescendantWinner(candidate.path, winners)) continue;
      const fieldSchema = schemaAtPath(schema, candidate.path);
      const nextValue =
        coerce && entry.source.kind === 'string' && fieldSchema !== undefined
          ? coerceValue(candidate.value, fieldSchema)
          : candidate.value;
      setValueAtPath(values, candidate.path, nextValue);
      winners.set(candidate.path, layer);
      provenance[candidate.path] = layer;
    }
  }

  const trace: Record<
    string,
    { winning: Provenance | undefined; considered: readonly Provenance[] }
  > = {};
  for (const path of schemaLeafPaths(schema)) {
    const considered: Provenance[] = [];
    for (const entry of loaded) {
      if (sourceContains(entry.candidates, path)) {
        considered.push({ source: entry.source.id, location: entry.result.location });
      }
    }
    trace[path] = { winning: winners.get(path), considered };
  }

  const checked: Record<string, readonly string[]> = {};
  for (const key of schemaTopLevelKeys(schema)) {
    checked[key] = sources.map((source) => sourceLabel(source, key, options, extras));
  }

  const result: ResolvedRaw = {
    values,
    provenance,
    trace,
    checked,
    defaultsExcluded: !sources.some((source) => source.id === 'defaults'),
  };
  options.onResolve?.(trace);
  void context;
  return result;
}

/** Resolve an already-assembled source chain asynchronously. */
export async function resolveCore(
  schema: z.ZodObject,
  options: ResolveCoreOptions,
  sources: readonly Source[],
  context: SourceContext,
  extras: ResolveExtras = {},
): Promise<ResolvedRaw> {
  guardRequiredOptions({ name: options.name, schema });
  guardSchema(schema, options.name);
  const loaded = applyEnvironmentOverrides(
    await loadSources(sources, context),
    sources,
    context,
    extras.envOverrides,
  );
  return resolveLoaded(schema, options, context, sources, loaded, extras);
}

/** Resolve an already-assembled source chain synchronously. */
export function resolveCoreSync(
  schema: z.ZodObject,
  options: ResolveCoreOptions,
  sources: readonly Source[],
  context: SourceContext,
  extras: ResolveExtras = {},
): ResolvedRaw {
  guardRequiredOptions({ name: options.name, schema });
  guardSchema(schema, options.name);
  const loaded = applyEnvironmentOverrides(
    loadSourcesSync(sources, context),
    sources,
    context,
    extras.envOverrides,
  );
  return resolveLoaded(schema, options, context, sources, loaded, extras);
}

/** Narrow a full resolver options object to the neutral engine contract. */
export function coreOptions<S extends z.ZodObject>(
  options: EnvironmentalistOptions<S>,
  cwd: string,
): ResolveCoreOptions {
  return {
    name: options.name,
    cwd,
    ...(options.envPrefix === undefined ? {} : { envPrefix: options.envPrefix }),
    ...(options.coerce === undefined ? {} : { coerce: options.coerce }),
    ...(options.onResolve === undefined ? {} : { onResolve: options.onResolve }),
  };
}
