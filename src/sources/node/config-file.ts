import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Source, SourceContext, SourceResult } from '../../types.js';

import { normalizeRecord } from './helpers.js';
import { createConfigLoader } from './loader.js';
import { loadStructuredFile, loadStructuredFileSync } from './parsers.js';
import type { NodeSourceOptions } from './options.js';
import { directoriesToWorkspaceRoot } from './workspace.js';

/** Configuration extensions in their documented discovery order. */
export const CONFIG_EXTENSIONS = [
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.toml',
  '.yaml',
  '.yml',
] as const;

function discoverFiles(context: SourceContext, options: NodeSourceOptions): string[] {
  const files: string[] = [];
  for (const directory of directoriesToWorkspaceRoot(context.cwd, options)) {
    const file = CONFIG_EXTENSIONS.map((extension) =>
      join(directory, `${context.name}.config${extension}`),
    ).find((location) => existsSync(location));
    if (file !== undefined) {
      files.push(file);
    }
  }
  return files;
}

function mergeNearest(
  values: readonly (Record<string, unknown> | undefined)[],
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  let found = false;
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    found = true;
    for (const [key, child] of Object.entries(value)) {
      if (!(key in merged)) {
        merged[key] = child;
      }
    }
  }
  return found ? merged : undefined;
}

async function loadConfig(
  context: SourceContext,
  options: NodeSourceOptions,
): Promise<SourceResult | undefined> {
  const files = discoverFiles(context, options);
  if (files.length === 0) {
    return undefined;
  }
  const loader = createConfigLoader(options.loader);
  const values = await Promise.all(
    files.map(async (file) => normalizeRecord(await loadStructuredFile(file, loader))),
  );
  const merged = mergeNearest(values);
  return merged === undefined ? undefined : { values: merged, location: files[0] ?? '' };
}

function loadConfigSync(
  context: SourceContext,
  options: NodeSourceOptions,
): SourceResult | undefined {
  const files = discoverFiles(context, options);
  if (files.length === 0) {
    return undefined;
  }
  const loader = createConfigLoader(options.loader);
  const values = files.map((file) => {
    const value = loadStructuredFileSync(file, loader);
    return normalizeRecord(value);
  });
  const merged = mergeNearest(values);
  return merged === undefined ? undefined : { values: merged, location: files[0] ?? '' };
}

/** Create a source that discovers and merges project configuration layers. */
export function createConfigFileSource(options: NodeSourceOptions = {}): Source {
  return {
    id: 'project-config',
    kind: 'typed',
    load: (context) => loadConfig(context, options),
    loadSync: (context) => loadConfigSync(context, options),
  };
}

/** Alias for {@link createConfigFileSource}. */
export const configFileSource = createConfigFileSource;

/** Alias for {@link createConfigFileSource} using the source's public identifier. */
export const createProjectConfigSource = createConfigFileSource;
