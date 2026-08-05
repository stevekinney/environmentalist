import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'dotenv';
import { expand } from 'dotenv-expand';

import { canonicalizeKey, tryCanonicalizeKey } from '../../keys.js';
import type { Source, SourceContext, SourceResult } from '../../types.js';

import { normalizeFlatEntries } from './helpers.js';

function cascadeFiles(context: SourceContext): string[] {
  const names =
    context.mode === undefined
      ? ['.env.local', '.env']
      : [`.env.${context.mode}.local`, '.env.local', `.env.${context.mode}`, '.env'];
  return names.map((name) => join(context.cwd, name)).filter((location) => existsSync(location));
}

/**
 * Apply `meta({ env })` forced names to the entries parsed from `.env` files.
 *
 * A `.env` file holds environment variables, so a forced name has to replace
 * the derived spelling here for the same reason it does in `process.env`: a
 * key named `file` derives `FILE`, and a stray `FILE=` would otherwise still
 * claim it.
 */
function applyForcedNames(
  entries: ReadonlyArray<readonly [string, string]>,
  overrides: Readonly<Record<string, string>>,
): Array<readonly [string, string]> {
  const forced = Object.entries(overrides);
  if (forced.length === 0) return [...entries];

  const overridden = new Set(forced.map(([key]) => canonicalizeKey(key)));
  const byName = new Map(entries.map(([name, value]) => [name, value] as const));
  const result = entries.filter(([name]) => {
    const canonical = tryCanonicalizeKey(name);
    return canonical === undefined || !overridden.has(canonical);
  });

  for (const [key, forcedName] of forced) {
    const value = byName.get(forcedName) ?? byName.get(forcedName.replaceAll('__', '.'));
    if (value !== undefined) result.push([canonicalizeKey(key), value]);
  }

  return result;
}

function expandFiles(
  files: readonly string[],
  contents: readonly string[],
  overrides: Readonly<Record<string, string>>,
): Record<string, unknown> | undefined {
  const isolated: Record<string, string> = {};
  const claimed = new Set<string>();
  const parsedValues: Array<readonly [string, string]> = [];

  for (let index = 0; index < files.length; index += 1) {
    const parsed = parse(contents[index] ?? '');
    expand({ parsed, processEnv: isolated });
    for (const [key, value] of Object.entries(parsed)) {
      if (!claimed.has(key)) {
        parsedValues.push([key.replaceAll('__', '.'), value]);
        claimed.add(key);
      }
    }
  }

  const values = applyForcedNames(parsedValues, overrides);
  if (values.length === 0) {
    return undefined;
  }

  const normalized = normalizeFlatEntries(values);

  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

async function loadDotenv(context: SourceContext): Promise<SourceResult | undefined> {
  const files = cascadeFiles(context);
  if (files.length === 0) {
    return undefined;
  }
  const contents = await Promise.all(files.map((location) => readFile(location, 'utf8')));
  const values = expandFiles(files, contents, context.envOverrides ?? {});
  return values === undefined ? undefined : { values, location: files.join(', ') };
}

function loadDotenvSync(context: SourceContext): SourceResult | undefined {
  const files = cascadeFiles(context);
  if (files.length === 0) {
    return undefined;
  }
  const values = expandFiles(
    files,
    files.map((location) => readFileSync(location, 'utf8')),
    context.envOverrides ?? {},
  );
  return values === undefined ? undefined : { values, location: files.join(', ') };
}

/** Create a source for the mode-aware dotenv file cascade. */
export function createDotenvSource(): Source {
  return {
    id: 'dotenv',
    kind: 'string',
    load: loadDotenv,
    loadSync: loadDotenvSync,
  };
}

/** Alias for {@link createDotenvSource}. */
export const dotenvSource = createDotenvSource;
