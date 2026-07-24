/* eslint-disable complexity, typescript/no-unsafe-type-assertion */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

import { canonicalizeKey, toEnvName } from '../keys.js';
import { metadataFor, secretKeysOf } from '../metadata.js';
import { schemaShape } from '../source-chain.js';

type SchemaRecord = Record<string, unknown>;

/** Supported configuration scaffold formats. */
export type InitializeFormat = 'ts' | 'json' | 'toml' | 'yaml';

/** Options for generating a starter configuration file. */
export type InitializeOptions = {
  readonly name: string;
  readonly schema: z.ZodObject;
  readonly format?: InitializeFormat;
  readonly cwd?: string;
  readonly envExample?: boolean;
};

type FieldInfo = {
  readonly base: unknown;
  readonly defaulted: boolean;
  readonly defaultValue: unknown;
  readonly optional: boolean;
  readonly nullable: boolean;
};

function isRecord(value: unknown): value is SchemaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function definition(schema: unknown): SchemaRecord | undefined {
  if (!isRecord(schema)) return undefined;
  const zod = schema['_zod'];
  if (isRecord(zod) && isRecord(zod['def'])) return zod['def'];
  if (isRecord(schema['def'])) return schema['def'];
  if (isRecord(schema['_def'])) return schema['_def'];
  return undefined;
}

function fieldInfo(schema: unknown): FieldInfo {
  let current = schema;
  let defaulted = false;
  let defaultValue: unknown;
  let optional = false;
  let nullable = false;
  const seen = new Set<unknown>();

  while (!seen.has(current)) {
    seen.add(current);
    const def = definition(current);
    if (def === undefined) break;
    const type = def['type'];
    if (type === 'default') {
      defaulted = true;
      defaultValue =
        typeof def['defaultValue'] === 'function' ? def['defaultValue']() : def['defaultValue'];
      current = def['innerType'];
      continue;
    }
    if (type === 'optional' || type === 'catch') optional = true;
    if (type === 'nullable') nullable = true;
    if (
      (type === 'optional' || type === 'nullable' || type === 'catch') &&
      def['innerType'] !== undefined
    ) {
      current = def['innerType'];
      continue;
    }
    break;
  }

  return { base: current, defaulted, defaultValue, optional, nullable };
}

function schemaType(schema: unknown): string | undefined {
  return typeof definition(schema)?.['type'] === 'string'
    ? (definition(schema)?.['type'] as string)
    : undefined;
}

function enumValue(schema: unknown): unknown {
  const entries = definition(schema)?.['entries'];
  if (isRecord(entries)) return Object.values(entries)[0];
  const values = definition(schema)?.['values'];
  return Array.isArray(values) ? values[0] : undefined;
}

function placeholder(info: FieldInfo): unknown {
  if (info.nullable) return null;
  switch (schemaType(info.base)) {
    case 'string':
    case 'template_literal':
      return 'value';
    case 'number':
      return 1;
    case 'bigint':
      return 1n;
    case 'boolean':
      return false;
    case 'date':
      return '2020-01-01T00:00:00.000Z';
    case 'array':
    case 'tuple':
      return [];
    case 'object':
    case 'record':
      return {};
    case 'enum':
      return enumValue(info.base) ?? 'value';
    case 'literal': {
      const values = definition(info.base)?.['values'];
      return Array.isArray(values) ? values[0] : 'value';
    }
    case 'union': {
      const options = definition(info.base)?.['options'];
      return Array.isArray(options) && options[0] !== undefined
        ? placeholder(fieldInfo(options[0]))
        : 'value';
    }
    default:
      return info.optional ? undefined : 'value';
  }
}

function fieldValue(field: unknown, path: string, secrets: ReadonlySet<string>): unknown {
  const info = fieldInfo(field);
  if (secrets.has(path)) return '';
  if (info.defaulted) return info.defaultValue;
  const example = metadataFor(field as z.ZodType).example;
  if (example !== undefined) return example;

  const shape = schemaShape(info.base);
  if (shape !== undefined) {
    const value: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(shape)) {
      const childPath =
        path.length === 0 ? canonicalizeKey(key) : `${path}.${canonicalizeKey(key)}`;
      value[canonicalizeKey(key)] = fieldValue(child, childPath, secrets);
    }
    return value;
  }
  return placeholder(info);
}

function configuredValue(
  schema: z.ZodObject,
  secrets: ReadonlySet<string>,
): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schemaShape(schema) ?? {})) {
    const canonical = canonicalizeKey(key);
    value[canonical] = fieldValue(field, canonical, secrets);
  }
  return value;
}

function commentValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function fieldComments(field: unknown, path: string, indent: string): string[] {
  const metadata = metadataFor(field as z.ZodType);
  const info = fieldInfo(field);
  const lines: string[] = [];
  if (metadata.description !== undefined) lines.push(`${indent}# ${metadata.description}`);
  if (metadata.example !== undefined)
    lines.push(`${indent}# Example: ${commentValue(metadata.example)}`);
  if (!info.defaulted && !info.optional) lines.push(`${indent}# Required: provide a value`);
  if (path.length > 0 && lines.length === 0) lines.push(`${indent}# ${path}`);
  return lines;
}

function keyForSource(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : JSON.stringify(key);
}

function serializeTs(value: unknown, indent: string): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value))
    return `[${value.map((child) => serializeTs(child, indent)).join(', ')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).map(
      ([key, child]) => `${keyForSource(key)}: ${serializeTs(child, indent + '  ')}`,
    );
    return `{ ${entries.join(', ')} }`;
  }
  return JSON.stringify(Object.prototype.toString.call(value));
}

function renderTsObject(
  schema: z.ZodObject,
  secrets: ReadonlySet<string>,
  prefix: string,
  indent: string,
): string {
  const lines = ['{'];
  for (const [key, field] of Object.entries(schemaShape(schema) ?? {})) {
    const canonical = canonicalizeKey(key);
    const path = prefix.length === 0 ? canonical : `${prefix}.${canonical}`;
    lines.push(
      ...fieldComments(field, path, `${indent}  `).map((line) => `// ${line.trimStart()}`),
    );
    const info = fieldInfo(field);
    const nested = schemaShape(info.base) !== undefined && !info.defaulted && !secrets.has(path);
    const value = nested
      ? renderTsObject(info.base as z.ZodObject, secrets, path, `${indent}  `)
      : serializeTs(fieldValue(field, path, secrets), `${indent}  `);
    lines.push(`${indent}  ${keyForSource(canonical)}: ${value},`);
  }
  lines.push(`${indent}}`);
  return lines.join('\n');
}

function renderComments(schema: z.ZodObject, secrets: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  const visit = (current: unknown, prefix: string): void => {
    for (const [key, field] of Object.entries(schemaShape(current) ?? {})) {
      const path = prefix.length === 0 ? canonicalizeKey(key) : `${prefix}.${canonicalizeKey(key)}`;
      const comments = fieldComments(field, path, '');
      lines.push(...comments);
      if (!secrets.has(path) && !fieldInfo(field).defaulted) visit(field, path);
    }
  };
  visit(schema, '');
  return lines;
}

function jsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
  return value;
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  return JSON.stringify(value);
}

function renderToml(value: Record<string, unknown>): string {
  const lines: string[] = [];
  const visit = (current: Record<string, unknown>, prefix: string): void => {
    const primitives = Object.entries(current).filter(([, child]) => !isRecord(child));
    for (const [key, child] of primitives) lines.push(`${key} = ${tomlValue(child)}`);
    for (const [key, child] of Object.entries(current)) {
      if (!isRecord(child)) continue;
      const section = prefix.length === 0 ? key : `${prefix}.${key}`;
      lines.push('', `[${section}]`);
      visit(child, section);
    }
  };
  visit(value, '');
  return lines.join('\n').replace(/^\n/u, '');
}

function envLines(schema: z.ZodObject, secrets: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  const visit = (current: unknown, prefix: string): void => {
    for (const [key, field] of Object.entries(schemaShape(current) ?? {})) {
      const canonical = canonicalizeKey(key);
      const path = prefix.length === 0 ? canonical : `${prefix}.${canonical}`;
      const shape = schemaShape(fieldInfo(field).base);
      if (shape !== undefined && !fieldInfo(field).defaulted && !secrets.has(path)) {
        visit(field, path);
        continue;
      }
      const metadata = metadataFor(field as z.ZodType);
      if (metadata.description !== undefined) lines.push(`# ${metadata.description}`);
      const example = !secrets.has(path) ? metadata.example : undefined;
      lines.push(
        `${metadata.env ?? toEnvName(path)}=${example === undefined ? '' : commentValue(example)}`,
      );
    }
  };
  visit(schema, '');
  return lines;
}

/**
 * Write a starter configuration. JSON is deliberately comment-free so it can
 * accept a `$schema` property; add that property when placing a schema beside it.
 */
export async function initialize(options: InitializeOptions): Promise<void> {
  const format = options.format ?? 'ts';
  const cwd = options.cwd ?? process.cwd();
  const secrets = secretKeysOf(options.schema);
  const values = configuredValue(options.schema, secrets);
  let contents: string;

  switch (format) {
    case 'ts':
      contents = `export default ${renderTsObject(options.schema, secrets, '', '')};\n`;
      break;
    case 'json':
      contents = `${JSON.stringify(jsonValue(values), null, 2)}\n`;
      break;
    case 'toml':
      contents = `${renderComments(options.schema, secrets).join('\n')}\n${renderToml(values)}\n`;
      break;
    case 'yaml':
      contents = `${renderComments(options.schema, secrets).join('\n')}\n${stringifyYaml(jsonValue(values))}`;
      break;
    default:
      throw new Error(`Unsupported initialization format: ${String(format)}`);
  }

  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, `${options.name}.config.${format}`), contents, 'utf8');
  if (options.envExample) {
    await writeFile(
      join(cwd, '.env.example'),
      `${envLines(options.schema, secrets).join('\n')}\n`,
      'utf8',
    );
  }
}
