/* eslint-disable complexity, typescript/no-unsafe-type-assertion */

import type { z } from 'zod';

import { canonicalizeKey, toFlagName } from './keys.js';
import { flagOverridesOf, metadataFor, secretKeysOf } from './metadata.js';
import { schemaShape } from './resolve-core.js';
import type { PositionalSpec } from './flags.js';

type SchemaRecord = Record<string, unknown>;

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

type FieldInfo = {
  readonly base: unknown;
  readonly optional: boolean;
  readonly defaulted: boolean;
  readonly defaultValue: unknown;
};

function fieldInfo(schema: unknown): FieldInfo {
  let current = schema;
  let optional = false;
  let defaulted = false;
  let defaultValue: unknown;
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
    if (type === 'optional' || type === 'nullable' || type === 'catch') optional = true;
    if (
      (type === 'optional' || type === 'nullable' || type === 'catch') &&
      def['innerType'] !== undefined
    ) {
      current = def['innerType'];
      continue;
    }
    break;
  }

  return { base: current, optional, defaulted, defaultValue };
}

function fieldTypeName(schema: unknown): string {
  const type = definition(schema)?.['type'];
  return typeof type === 'string' ? type : 'value';
}

function formatDefault(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

type Row = { readonly left: string; readonly right: string };

function renderColumns(rows: readonly Row[]): string[] {
  const width = Math.max(0, ...rows.map((row) => row.left.length));
  return rows.map((row) =>
    row.right.length === 0 ? row.left : `${row.left.padEnd(width + 2)}${row.right}`,
  );
}

/** Options for generating usage/help text for a schema-backed CLI. */
export type HelpOptions<S extends z.ZodObject> = {
  readonly name: string;
  readonly schema: S;
  readonly description?: string;
  readonly usage?: string;
  readonly positionals?: readonly PositionalSpec[];
};

/**
 * Render `--help`-style usage text from a schema's top-level fields and
 * metadata (description, example, secret) plus an optional positional spec.
 * Only top-level keys are listed—nested keys still resolve via dot-path
 * flags, but don't get their own help row.
 */
export function generateHelp<S extends z.ZodObject>(options: HelpOptions<S>): string {
  const secrets = secretKeysOf(options.schema);
  const flagOverrides = flagOverridesOf(options.schema);
  const shape = schemaShape(options.schema) ?? {};

  const flagRows: Row[] = Object.entries(shape).map(([originalKey, field]) => {
    const canonical = canonicalizeKey(originalKey);
    const info = fieldInfo(field);
    const metadata = metadataFor(field as z.ZodType);
    const flagName = flagOverrides[canonical] ?? toFlagName(canonical);
    const required = !info.optional && !info.defaulted;
    const notes: string[] = [];
    if (metadata.description !== undefined) notes.push(metadata.description);
    if (secrets.has(canonical)) notes.push('(secret)');
    if (required) notes.push('(required)');
    else if (info.defaulted) notes.push(`(default: ${formatDefault(info.defaultValue)})`);
    return { left: `  --${flagName} <${fieldTypeName(info.base)}>`, right: notes.join(' ') };
  });

  const positionals = options.positionals ?? [];
  const positionalRows: Row[] = positionals.map((entry) => {
    const label = entry.variadic ? `${entry.name}...` : entry.name;
    const required = entry.required ?? !entry.variadic;
    return {
      left: `  ${required ? `<${label}>` : `[${label}]`}`,
      right: entry.description ?? '',
    };
  });

  const usage =
    options.usage ??
    `${options.name}${
      positionals.length > 0
        ? ` ${positionals
            .map((entry) => {
              const label = entry.variadic ? `${entry.name}...` : entry.name;
              return (entry.required ?? !entry.variadic) ? `<${label}>` : `[${label}]`;
            })
            .join(' ')}`
        : ''
    } [flags]`;

  const lines: string[] = [
    options.description === undefined ? options.name : `${options.name} — ${options.description}`,
    '',
    `Usage: ${usage}`,
  ];

  if (positionalRows.length > 0) lines.push('', 'Positionals:', ...renderColumns(positionalRows));
  if (flagRows.length > 0) lines.push('', 'Flags:', ...renderColumns(flagRows));

  return lines.join('\n');
}
