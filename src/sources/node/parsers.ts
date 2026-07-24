import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { parse as parseDotenv } from 'dotenv';
import { parse as parseToml } from 'toml';
import { parse as parseYaml } from 'yaml';

import { isRecord } from './helpers.js';
import type { ModuleLoader } from './loader.js';

type StructuredExtension = '.json' | '.jsonc' | '.toml' | '.yaml' | '.yml';

function stripJsonComments(input: string): string {
  return input.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu,
    (_match, stringValue: string | undefined) => stringValue ?? '',
  );
}

function parseStructuredText(input: string, extension: StructuredExtension): unknown {
  if (extension === '.json') return JSON.parse(input);
  if (extension === '.jsonc') return JSON.parse(stripJsonComments(input));
  if (extension === '.toml') return parseToml(input);
  return parseYaml(input);
}

function unwrapModule(value: unknown): unknown {
  if (isRecord(value) && 'default' in value) {
    return value['default'];
  }
  return value;
}

async function callExport(value: unknown): Promise<unknown> {
  return typeof value === 'function' ? value() : value;
}

function callExportSync(value: unknown): unknown {
  return typeof value === 'function' ? value() : value;
}

/** Load and parse one structured or executable configuration file. */
export async function loadStructuredFile(location: string, loader: ModuleLoader): Promise<unknown> {
  const extension = extname(location).toLowerCase();
  if (
    extension === '.json' ||
    extension === '.jsonc' ||
    extension === '.toml' ||
    extension === '.yaml' ||
    extension === '.yml'
  ) {
    return parseStructuredText(await readFile(location, 'utf8'), extension);
  }
  return callExport(unwrapModule(await loader.load(location)));
}

/** Synchronous counterpart to {@link loadStructuredFile}. */
export function loadStructuredFileSync(location: string, loader: ModuleLoader): unknown {
  const extension = extname(location).toLowerCase();
  if (
    extension === '.json' ||
    extension === '.jsonc' ||
    extension === '.toml' ||
    extension === '.yaml' ||
    extension === '.yml'
  ) {
    return parseStructuredText(readFileSync(location, 'utf8'), extension);
  }
  if (loader.loadSync === undefined) {
    return undefined;
  }
  return callExportSync(unwrapModule(loader.loadSync(location)));
}

/** Parse an extensionless user dotfile as JSON, falling back to dotenv syntax. */
export function parseUserDotfile(input: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return parseDotenv(input);
  }
}
