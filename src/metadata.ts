/* eslint-disable complexity, typescript/no-unsafe-type-assertion */

import { z } from 'zod';

import { canonicalizeKey } from './keys.js';

/** Metadata Environmentalist understands for a configuration field. */
export type EnvironmentalistMetadata = {
  readonly description?: string;
  readonly example?: unknown;
  readonly docs?: string;
  readonly deprecated?: boolean;
  readonly secret?: boolean;
  readonly env?: string;
  readonly flag?: string;
};

/** Typed registry for Environmentalist field metadata. */
export const registry = z.registry<EnvironmentalistMetadata>();

type SchemaRecord = Record<string, unknown>;

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

function shapeOf(schema: unknown): Record<string, z.ZodType> | undefined {
  const def = definition(unwrap(schema));
  if (def?.['type'] !== 'object') return undefined;
  const shape = def['shape'];
  return typeof shape === 'object' && shape !== null
    ? (shape as Record<string, z.ZodType>)
    : undefined;
}

type MetadataLayer = {
  readonly typed?: EnvironmentalistMetadata;
  readonly global?: Record<string, unknown>;
};

function metadataAt(schema: z.ZodType): MetadataLayer {
  if (!isRecord(schema) || !isRecord(schema['_zod'])) return {};
  const typed = registry.get(schema);
  const global = z.globalRegistry.get(schema);
  return {
    ...(typed === undefined ? {} : { typed }),
    ...(global === undefined ? {} : { global }),
  };
}

/** Read merged metadata, including metadata registered on unwrapped schemas. */
export function metadataFor(fieldSchema: z.ZodType): EnvironmentalistMetadata {
  const typed: EnvironmentalistMetadata = {};
  const global: EnvironmentalistMetadata = {};
  let current: unknown = fieldSchema;
  const seen = new Set<unknown>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const layer = metadataAt(current as z.ZodType);
    for (const [key, value] of Object.entries(layer.global ?? {})) {
      if (!(key in global)) (global as Record<string, unknown>)[key] = value;
    }
    for (const [key, value] of Object.entries(layer.typed ?? {})) {
      if (!(key in typed)) (typed as Record<string, unknown>)[key] = value;
    }
    const def = definition(current);
    const type = def?.['type'];
    if (
      (type === 'optional' || type === 'nullable' || type === 'default' || type === 'catch') &&
      def?.['innerType'] !== undefined
    ) {
      current = def['innerType'];
    } else {
      break;
    }
  }
  return { ...global, ...typed };
}

/** Mark a Zod schema as containing a secret value. */
export function secret<T extends z.ZodType>(schema: T): T {
  registry.add(schema, { secret: true });
  return schema;
}

function collectMetadata(
  schema: z.ZodObject,
  predicate: (metadata: EnvironmentalistMetadata) => string | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};

  const visit = (current: unknown, prefix: string): void => {
    const shape = shapeOf(current);
    if (shape === undefined) {
      const metadata = metadataFor(current as z.ZodType);
      const value = predicate(metadata);
      if (value !== undefined && prefix.length > 0) result[prefix] = value;
      return;
    }
    for (const [originalKey, field] of Object.entries(shape)) {
      const path =
        prefix.length === 0
          ? canonicalizeKey(originalKey)
          : `${prefix}.${canonicalizeKey(originalKey)}`;
      const metadata = metadataFor(field);
      const value = predicate(metadata);
      if (value !== undefined) result[path] = value;
      visit(field, path);
    }
  };

  visit(schema, '');
  return result;
}

/** Return canonical dotted paths for secret-marked fields. */
export function secretKeysOf(schema: z.ZodObject): ReadonlySet<string> {
  return new Set(
    Object.keys(collectMetadata(schema, (metadata) => (metadata.secret ? 'secret' : undefined))),
  );
}

/** Return canonical keys with forced environment-variable spellings. */
export function envOverridesOf(schema: z.ZodObject): Readonly<Record<string, string>> {
  return collectMetadata(schema, (metadata) => metadata.env);
}

/** Return canonical keys with forced command-line flag spellings. */
export function flagOverridesOf(schema: z.ZodObject): Readonly<Record<string, string>> {
  return collectMetadata(schema, (metadata) => metadata.flag);
}
