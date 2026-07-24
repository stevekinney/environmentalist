import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'dotenv';
import { expand } from 'dotenv-expand';

import type { Source, SourceContext, SourceResult } from '../../types.js';

import { normalizeFlatEntries } from './helpers.js';

function cascadeFiles(context: SourceContext): string[] {
  const names =
    context.mode === undefined
      ? ['.env.local', '.env']
      : [`.env.${context.mode}.local`, '.env.local', `.env.${context.mode}`, '.env'];
  return names.map((name) => join(context.cwd, name)).filter((location) => existsSync(location));
}

function expandFiles(
  files: readonly string[],
  contents: readonly string[],
): Record<string, unknown> | undefined {
  const isolated: Record<string, string> = {};
  const claimed = new Set<string>();
  const values: Array<readonly [string, string]> = [];

  for (let index = 0; index < files.length; index += 1) {
    const parsed = parse(contents[index] ?? '');
    expand({ parsed, processEnv: isolated });
    for (const [key, value] of Object.entries(parsed)) {
      if (!claimed.has(key)) {
        values.push([key.replaceAll('__', '.'), value]);
        claimed.add(key);
      }
    }
  }

  return values.length === 0 ? undefined : normalizeFlatEntries(values);
}

async function loadDotenv(context: SourceContext): Promise<SourceResult | undefined> {
  const files = cascadeFiles(context);
  if (files.length === 0) {
    return undefined;
  }
  const contents = await Promise.all(files.map((location) => readFile(location, 'utf8')));
  const values = expandFiles(files, contents);
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
