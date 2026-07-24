import { canonicalizeKey, normalizeKeys } from './keys.js';
import type { Provenance, Source, SourceContext, SourceResult } from './types.js';

type SchemaRecord = Record<string, unknown>;

/** A flattened source value used by the precedence merge. */
export type ResolutionCandidate = { readonly path: string; readonly value: unknown };

/** A source result prepared for the precedence merge. */
export type LoadedSource = {
  readonly source: Source;
  readonly result: SourceResult;
  readonly values: Record<string, unknown>;
  readonly candidates: readonly ResolutionCandidate[];
};

/** Test whether a value is a plain object-like source record. */
export function isRecord(value: unknown): value is SchemaRecord {
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

function typeOfSchema(schema: unknown): string | undefined {
  const type = definition(unwrap(schema))?.['type'];
  return typeof type === 'string' ? type : undefined;
}

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!(
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  )) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function coerceBoolean(value: string): boolean | string {
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return value;
}

function coerceScalar(value: string, type: string | undefined): unknown {
  if (type === 'number') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (type === 'bigint') {
    try {
      return BigInt(value);
    } catch {
      return value;
    }
  }
  if (type === 'boolean') return coerceBoolean(value);
  if (type === 'date') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed;
  }
  return value;
}

function arrayElement(schema: unknown): unknown {
  const def = definition(unwrap(schema));
  return def?.['type'] === 'array' ? def['element'] : undefined;
}

/** Coerce a string-origin value according to the innermost Zod schema type. */
export function coerceValue(value: unknown, fieldSchema: unknown): unknown {
  const target = unwrap(fieldSchema);
  const type = typeOfSchema(target);

  if (type === 'array') {
    const element = arrayElement(target);
    if (Array.isArray(value)) {
      return value.map((item) =>
        typeof item === 'string' && element !== undefined ? coerceValue(item, element) : item,
      );
    }
    if (typeof value === 'string') {
      const parsed = parseJson(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) =>
          typeof item === 'string' && element !== undefined ? coerceValue(item, element) : item,
        );
      }
      return parsed;
    }
    return value;
  }

  if (typeof value === 'string' && (type === 'object' || type === 'record')) {
    return parseJson(value);
  }

  return typeof value === 'string' ? coerceScalar(value, type) : value;
}

/** Set one canonical dotted path without mutating an existing source object. */
export function setValueAtPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = path.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (isRecord(child) && !Array.isArray(child)) {
      current = child;
    } else {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    }
  }
  const leaf = segments.at(-1);
  if (leaf !== undefined) current[leaf] = value;
}

/** Read one canonical dotted path from a nested record. */
export function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Flatten nested source records into canonical dotted paths. */
export function flattenSourceValue(
  value: unknown,
  prefix: string,
  candidates: ResolutionCandidate[],
): void {
  if (isRecord(value) && !Array.isArray(value) && !(value instanceof Date)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      if (prefix.length > 0) candidates.push({ path: prefix, value });
      return;
    }
    for (const [key, child] of entries) {
      const path = prefix.length === 0 ? canonicalizeKey(key) : `${prefix}.${canonicalizeKey(key)}`;
      flattenSourceValue(child, path, candidates);
    }
    return;
  }
  if (prefix.length > 0) candidates.push({ path: prefix, value });
}

/** Test whether two dotted paths overlap at an object boundary. */
export function pathsRelate(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

/** Test whether a higher-priority winner contains the candidate path. */
export function hasAncestorWinner(path: string, winners: ReadonlyMap<string, Provenance>): boolean {
  const segments = path.split('.');
  return segments
    .slice(1)
    .some((_segment, index) => winners.has(segments.slice(0, index + 1).join('.')));
}

/** Test whether a higher-priority winner is nested below the candidate path. */
export function hasDescendantWinner(
  path: string,
  winners: ReadonlyMap<string, Provenance>,
): boolean {
  const prefix = `${path}.`;
  return [...winners.keys()].some((winner) => winner.startsWith(prefix));
}

/** Prepare one source result for merging. */
export function prepareSource(source: Source, result: SourceResult): LoadedSource {
  const values = normalizeKeys(result.values);
  const candidates: ResolutionCandidate[] = [];
  flattenSourceValue(values, '', candidates);
  return { source, result, values, candidates };
}

/** Load all asynchronous source results in chain order. */
export async function loadSources(
  sources: readonly Source[],
  context: SourceContext,
): Promise<readonly LoadedSource[]> {
  const loaded = await Promise.all(
    sources.map(async (source) => {
      const result = await source.load(context);
      return result === undefined ? undefined : prepareSource(source, result);
    }),
  );
  return loaded.flatMap((entry) => (entry === undefined ? [] : [entry]));
}

/** Load synchronous source results, skipping sources without a sync loader. */
export function loadSourcesSync(
  sources: readonly Source[],
  context: SourceContext,
): readonly LoadedSource[] {
  const loaded: LoadedSource[] = [];
  for (const source of sources) {
    if (source.loadSync === undefined) continue;
    const result = source.loadSync(context);
    if (result !== undefined) loaded.push(prepareSource(source, result));
  }
  return loaded;
}

/** Apply exact environment names while preserving the environment source's precedence. */
export function applyEnvironmentOverrides(
  loaded: readonly LoadedSource[],
  sources: readonly Source[],
  context: SourceContext,
  overrides: Readonly<Record<string, string>> | undefined,
): readonly LoadedSource[] {
  if (overrides === undefined || Object.keys(overrides).length === 0) return loaded;
  const activeEnvSource = sources.find((source) => source.id === 'env');
  const input =
    activeEnvSource !== undefined && !loaded.some((entry) => entry.source.id === 'env')
      ? [...loaded, prepareSource(activeEnvSource, { values: {}, location: 'process.env' })]
      : loaded;
  return input
    .toSorted((left, right) => sources.indexOf(left.source) - sources.indexOf(right.source))
    .map((entry) => {
      if (entry.source.id !== 'env') return entry;
      const values = { ...entry.values };
      for (const [key, environmentName] of Object.entries(overrides)) {
        const value = context.env[environmentName];
        if (value !== undefined) setValueAtPath(values, canonicalizeKey(key), value);
      }
      return prepareSource(entry.source, { values, location: entry.result.location });
    });
}
