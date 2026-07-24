/* eslint-disable complexity, typescript/no-unsafe-type-assertion */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { canonicalizeKey } from '../keys.js';
import { metadataFor } from '../metadata.js';
import { environmentalist } from '../environmentalist.js';
import { SOURCES } from '../types.js';
import { schemaAtPath, schemaLeafPaths } from '../source-chain.js';
import { initialize } from '../tooling/initialize.js';
import { toJSONSchema } from '../tooling/to-json-schema.js';
import { locateSchema, nameFromEntry, requireObjectSchema } from './locate-schema.js';
import { generateTypes, rejectUnsupportedTypesFlags } from './generate-types.js';
import type { TypeGenerationKind } from './zod-to-ts.js';

type CliFlags = Record<string, unknown>;

function parseArguments(argv: readonly string[]): { positionals: string[]; flags: CliFlags } {
  const positionals: string[] = [];
  const flags: CliFlags = {};
  const booleanFlags = new Set(['help', 'static', 'augment', 'watch', 'sources', 'envExample']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const body = argument.slice(2);
    const equals = body.indexOf('=');
    const rawName = equals === -1 ? body : body.slice(0, equals);
    const name = canonicalizeKey(rawName);
    if (booleanFlags.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = equals === -1 ? argv[index + 1] : body.slice(equals + 1);
    if (equals === -1 && value !== undefined && !value.startsWith('-')) index += 1;
    flags[name] = value ?? true;
  }
  return { positionals, flags };
}

function flagString(flags: CliFlags, name: string): string | undefined {
  const value = flags[name];
  const selected = Array.isArray(value) ? value.at(-1) : value;
  return typeof selected === 'string' ? selected : undefined;
}

function flagBoolean(flags: CliFlags, name: string): boolean {
  return flags[name] === true;
}

function outputPath(flags: CliFlags, cwd: string): string | undefined {
  const out = flagString(flags, 'out');
  return out === undefined ? undefined : resolve(cwd, out);
}

function entryOptions(
  cwd: string,
  exportName: string | undefined,
): { cwd: string; exportName?: string } {
  return exportName === undefined ? { cwd } : { cwd, exportName };
}

async function writeOutput(target: string | undefined, contents: string): Promise<void> {
  if (target === undefined) {
    globalThis.console.log(contents.trimEnd());
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

async function runSchema(
  positionals: readonly string[],
  flags: CliFlags,
  cwd: string,
): Promise<void> {
  const entry = positionals[0];
  if (entry === undefined) throw new Error('Usage: environmentalist schema <entry> [--out file].');
  const exportName = flagString(flags, 'export');
  const located = await locateSchema(entry, {
    ...(exportName === undefined ? {} : { exportName }),
    cwd,
  });
  await writeOutput(
    outputPath(flags, cwd),
    `${JSON.stringify(toJSONSchema(located.schema), null, 2)}\n`,
  );
}

function initializeFormat(value: string | undefined): 'ts' | 'json' | 'toml' | 'yaml' {
  if (value === 'ts' || value === 'json' || value === 'toml' || value === 'yaml') return value;
  if (value === undefined) return 'ts';
  throw new Error(`Unsupported initialize format "${value}".`);
}

async function runInitialize(
  positionals: readonly string[],
  flags: CliFlags,
  cwd: string,
): Promise<void> {
  const entry = positionals[0];
  const name =
    flagString(flags, 'name') ?? (entry === undefined ? 'environment' : nameFromEntry(entry));
  let schema: z.ZodObject;
  if (entry === undefined) {
    schema = z.object({});
  } else {
    const located = await locateSchema(entry, entryOptions(cwd, flagString(flags, 'export')));
    schema = requireObjectSchema(located.schema);
  }
  await initialize({
    name,
    schema,
    format: initializeFormat(flagString(flags, 'format')),
    cwd,
    envExample: flagBoolean(flags, 'envExample'),
  });
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function printableValue(value: unknown, secret: boolean): string {
  if (secret) return 'REDACTED';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function safeProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/u.test(key),
    ),
  ) as Record<string, string>;
}

async function runPrint(
  positionals: readonly string[],
  flags: CliFlags,
  cwd: string,
): Promise<void> {
  const entry = positionals[0];
  if (entry === undefined) throw new Error('Usage: environmentalist print <entry>.');
  const exportName = flagString(flags, 'export');
  const located = await locateSchema(entry, {
    ...(exportName === undefined ? {} : { exportName }),
    cwd,
  });
  const schema = requireObjectSchema(located.schema);
  const name = flagString(flags, 'name') ?? nameFromEntry(entry);
  const environment =
    located.environment === undefined
      ? await environmentalist({
          ...located.options,
          ...(located.options?.['env'] === undefined ? { env: safeProcessEnvironment() } : {}),
          name,
          schema,
          cwd,
        })
      : (located.environment as Record<PropertyKey, unknown>);
  const secretKeys = new Set<string>();
  const lines = ['Key | Value | Source | Location | Description'];
  for (const key of schemaLeafPaths(schema)) {
    const field = schemaAtPath(schema, key);
    const metadata = field === undefined ? {} : metadataFor(field as z.ZodType);
    if (metadata.secret) secretKeys.add(key);
    const source = (
      (environment as Record<PropertyKey, unknown>)[SOURCES] as
        Record<string, { source: string; location: string } | undefined> | undefined
    )?.[key];
    lines.push(
      [
        key,
        printableValue(valueAtPath(environment, key), secretKeys.has(key)),
        source?.source ?? 'none',
        source?.location ?? '',
        metadata.description ?? '',
      ].join(' | '),
    );
  }
  globalThis.console.log(lines.join('\n'));
}

function help(command?: string): string {
  if (command === 'types') {
    return 'Usage: environmentalist types <entry> [--out file] [--type-name Name] [--kind input|output] [--static] [--format d.ts|ts]';
  }
  if (command === 'initialize')
    return 'Usage: environmentalist initialize [entry] [--name name] [--format ts|json|toml|yaml] [--env-example] [--cwd directory]';
  if (command === 'schema')
    return 'Usage: environmentalist schema <entry> [--export name] [--out file]';
  if (command === 'print')
    return 'Usage: environmentalist print <entry> [--export name] [--name name]';
  return 'Usage: environmentalist <types|initialize|schema|print> [options]\nUse --help after a subcommand for details.';
}

/** Dispatch a CLI invocation and return a process exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  const parsed = parseArguments(argv.slice(1));
  if (command === undefined || command === '--help' || flagBoolean(parsed.flags, 'help')) {
    globalThis.console.log(help(command));
    return 0;
  }
  const cwd =
    flagString(parsed.flags, 'cwd') === undefined
      ? process.cwd()
      : resolve(process.cwd(), flagString(parsed.flags, 'cwd') ?? process.cwd());
  try {
    switch (command) {
      case 'types':
        rejectUnsupportedTypesFlags(parsed.flags);
        if (parsed.positionals[0] === undefined) {
          throw new Error('Usage: environmentalist types <entry> [options].');
        }
        await writeOutput(
          outputPath(parsed.flags, cwd),
          await generateTypes({
            entry: parsed.positionals[0],
            kind: (flagString(parsed.flags, 'kind') ?? 'output') as TypeGenerationKind,
            cwd,
            static: flagBoolean(parsed.flags, 'static'),
            ...(flagString(parsed.flags, 'typeName') === undefined
              ? {}
              : { typeName: flagString(parsed.flags, 'typeName') as string }),
            ...(flagString(parsed.flags, 'export') === undefined
              ? {}
              : { exportName: flagString(parsed.flags, 'export') as string }),
            ...(flagString(parsed.flags, 'format') === undefined
              ? {}
              : { format: flagString(parsed.flags, 'format') as string }),
          }),
        );
        break;
      case 'initialize':
        await runInitialize(parsed.positionals, parsed.flags, cwd);
        break;
      case 'schema':
        await runSchema(parsed.positionals, parsed.flags, cwd);
        break;
      case 'print':
        await runPrint(parsed.positionals, parsed.flags, cwd);
        break;
      default:
        globalThis.console.error(`Unknown command "${command}".\n${help()}`);
        return 1;
    }
    return 0;
  } catch (error) {
    globalThis.console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const entryPath = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);

export function runCliEntrypoint(run: () => Promise<number> = main): Promise<void> {
  return run()
    .then((code) => {
      process.exitCode = code;
      return undefined;
    })
    .catch((error: unknown) => {
      globalThis.console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

export function runCliEntrypointIfMain(
  candidate: string | undefined = entryPath,
  module: string = modulePath,
): Promise<void> {
  return candidate !== undefined && resolve(candidate) === resolve(module)
    ? runCliEntrypoint()
    : Promise.resolve();
}

void runCliEntrypointIfMain();
