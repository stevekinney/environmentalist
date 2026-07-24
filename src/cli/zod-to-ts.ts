/* eslint-disable complexity */

import { canonicalizeKey } from '../keys.js';
import { schemaShape } from '../source-chain.js';
import type { z } from 'zod';

type SchemaRecord = Record<string, unknown>;
export type TypeGenerationKind = 'input' | 'output';

function isRecord(value: unknown): value is SchemaRecord {
  return typeof value === 'object' && value !== null;
}

function definition(schema: unknown): SchemaRecord | undefined {
  if (!isRecord(schema)) return undefined;
  const zod = schema['_zod'];
  if (isRecord(zod) && isRecord(zod['def'])) return zod['def'];
  return isRecord(schema['def']) ? schema['def'] : undefined;
}

function unwrap(schema: unknown, kind: TypeGenerationKind): { schema: unknown; optional: boolean } {
  let current = schema;
  let optional = false;
  const seen = new Set<unknown>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const def = definition(current);
    if (def === undefined) break;
    const type = def['type'];
    if (type === 'optional') optional = true;
    if (type === 'default' && kind === 'input') optional = true;
    if (
      (type === 'optional' || type === 'nullable' || type === 'default' || type === 'catch') &&
      def['innerType'] !== undefined
    ) {
      current = def['innerType'];
      continue;
    }
    break;
  }
  return { schema: current, optional };
}

function keyForType(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : JSON.stringify(key);
}

function literal(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'unknown';
}

function enumValues(def: SchemaRecord): readonly unknown[] {
  const entries = def['entries'];
  if (isRecord(entries)) return Object.values(entries);
  const values = def['values'];
  return Array.isArray(values) ? values : [];
}

function union(types: readonly string[]): string {
  return [...new Set(types)].join(' | ') || 'unknown';
}

function typeFor(schema: unknown, kind: TypeGenerationKind, seen: Set<unknown>): string {
  if (schema === undefined || seen.has(schema)) return 'unknown';
  seen.add(schema);
  const def = definition(schema);
  if (def === undefined) return 'unknown';
  const type = def['type'];

  switch (type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'bigint':
      return 'bigint';
    case 'date':
      return 'Date';
    case 'literal': {
      const values = def['values'];
      return Array.isArray(values) ? union(values.map(literal)) : 'unknown';
    }
    case 'enum':
      return union(enumValues(def).map(literal));
    case 'union': {
      const options = def['options'];
      return Array.isArray(options)
        ? union(options.map((option) => typeFor(option, kind, new Set(seen))))
        : 'unknown';
    }
    case 'array':
      return `Array<${typeFor(def['element'], kind, new Set(seen))}>`;
    case 'record':
      return `Record<string, ${typeFor(def['valueType'], kind, new Set(seen))}>`;
    case 'tuple': {
      const items = Array.isArray(def['items'])
        ? def['items'].map((item) => typeFor(item, kind, new Set(seen)))
        : [];
      const rest = def['rest'];
      return rest === undefined || rest === null
        ? `[${items.join(', ')}]`
        : `[${items.join(', ')}${items.length === 0 ? '' : ', '}${typeFor(rest, kind, new Set(seen))}[]]`;
    }
    case 'object':
      return objectType(schema, kind, seen);
    case 'optional':
    case 'nullable':
    case 'default':
    case 'catch':
      const inner = typeFor(def['innerType'], kind, new Set(seen));
      if (type === 'optional') return union([inner, 'undefined']);
      if (type === 'nullable') return union([inner, 'null']);
      return inner;
    case 'transform':
    case 'pipe':
      return 'unknown';
    case 'any':
    case 'unknown':
      return 'unknown';
    case 'never':
      return 'never';
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    default:
      return 'unknown';
  }
}

function objectType(schema: unknown, kind: TypeGenerationKind, seen: Set<unknown>): string {
  const shape = schemaShape(schema);
  if (shape === undefined) return 'Record<string, unknown>';
  const lines = Object.entries(shape).map(([originalKey, field]) => {
    const key = canonicalizeKey(originalKey);
    const fieldInfo = unwrap(field, kind);
    const marker = fieldInfo.optional ? '?' : '';
    return `  readonly ${keyForType(key)}${marker}: ${typeFor(field, kind, new Set(seen))};`;
  });
  return lines.length === 0
    ? '{ }'
    : `{
${lines.join('\n')}
}`;
}

/** Materialize a Zod v4 schema as a dependency-free TypeScript type expression. */
export function zodToType(schema: z.ZodType, kind: TypeGenerationKind = 'output'): string {
  return typeFor(schema, kind, new Set<unknown>());
}
