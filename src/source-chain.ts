import type { z } from 'zod';

import { createFlagsSource } from './flags.js';
import { canonicalizeKey } from './keys.js';
import { createSearchParamsSource } from './search-params.js';
import { createDefaultsSource, schemaLeafPaths } from './resolve-core.js';
import type { EnvironmentalistOptions, Source, SourceName, SourceSpec } from './types.js';
import {
  createConfigFileSource,
  createDotenvSource,
  createEnvSource,
  createHomeConfigSource,
  createPackageJsonSource,
  createUserDotfileSource,
  createXdgConfigSource,
} from './sources/node/index.js';
import type { NodeSourceOptions } from './sources/node/index.js';

/** Re-export neutral schema and defaults helpers for existing Node callers. */
export {
  createDefaultsSource,
  schemaAtPath,
  schemaDefaults,
  schemaLeafPaths,
  schemaShape,
  schemaTopLevelKeys,
  sourceLabel,
} from './resolve-core.js';
export type { SourceLabelExtras, SourceLabelOptions } from './resolve-core.js';

/** Options understood while assembling the Node source chain. */
export type SourceChainOptions<S extends z.ZodObject> = EnvironmentalistOptions<S> &
  Pick<NodeSourceOptions, 'home' | 'homeDirectory'>;

/** Extra source metadata supplied by the validation/metadata track. */
export type SourceChainExtras = {
  readonly flagOverrides?: Readonly<Record<string, string>>;
};

/** The stable default Node source order. */
export const DEFAULT_SOURCE_NAMES = [
  'flags',
  'search-params',
  'env',
  'dotenv',
  'project-config',
  'package-json',
  'user-dotfile',
  'xdg-config',
  'home-config',
  'defaults',
] as const satisfies readonly SourceName[];

function flagOverridesForSchema(
  schema: z.ZodObject,
  overrides: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const known = new Set(schemaLeafPaths(schema));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const canonicalKeyName = canonicalizeKey(key);
    if (known.has(canonicalKeyName) || known.has(canonicalKeyName.split('.')[0] ?? '')) {
      result[value] = canonicalKeyName;
    }
  }
  return result;
}

// eslint-disable-next-line complexity
function builtInSource<S extends z.ZodObject>(
  id: SourceName,
  schema: S,
  options: SourceChainOptions<S>,
  extras: SourceChainExtras,
): Source | undefined {
  const nodeOptions: NodeSourceOptions = {
    ...(options.envPrefix === undefined ? {} : { envPrefix: options.envPrefix }),
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.stopAt === undefined ? {} : { stopAt: options.stopAt }),
    ...(options.loader === undefined ? {} : { loader: options.loader }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
  };
  switch (id) {
    case 'flags': {
      const flagOptions = {
        flagOverrides: flagOverridesForSchema(schema, extras.flagOverrides),
        ...(options.argv === undefined ? {} : { argv: options.argv }),
        ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
      };
      return createFlagsSource(flagOptions);
    }
    case 'search-params':
      return options.search === undefined
        ? createSearchParamsSource()
        : createSearchParamsSource({ search: options.search });
    case 'env':
      return options.envPrefix === undefined
        ? createEnvSource()
        : createEnvSource({ envPrefix: options.envPrefix });
    case 'dotenv':
      return options.dotenv === false ? undefined : createDotenvSource();
    case 'project-config':
      return createConfigFileSource(nodeOptions);
    case 'package-json':
      return createPackageJsonSource(nodeOptions);
    case 'user-dotfile':
      return createUserDotfileSource(nodeOptions);
    case 'xdg-config':
      return createXdgConfigSource(nodeOptions);
    case 'home-config':
      return createHomeConfigSource(nodeOptions);
    case 'defaults':
      return createDefaultsSource(schema);
    default:
      return undefined;
  }
}

/** Assemble the active Node source chain, preserving the requested order. */
export function createSourceChain<S extends z.ZodObject>(
  schema: S,
  options: SourceChainOptions<S>,
  extras: SourceChainExtras = {},
): readonly Source[] {
  const specs: readonly SourceSpec[] = options.sources ?? DEFAULT_SOURCE_NAMES;
  const excluded = new Set(options.exclude ?? []);
  const sources: Source[] = [];
  for (const spec of specs) {
    if (typeof spec !== 'string') {
      sources.push(spec);
      continue;
    }
    if (excluded.has(spec)) continue;
    const source = builtInSource(spec, schema, options, extras);
    if (source !== undefined) sources.push(source);
  }
  return sources;
}

/** Alias for {@link createSourceChain}. */
export const buildSourceChain = createSourceChain;
