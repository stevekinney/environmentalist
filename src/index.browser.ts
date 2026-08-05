import { EnvironmentalistError } from './errors.js';
import { envOverridesOf, flagOverridesOf, registry, secret, secretKeysOf } from './metadata.js';
import { createBrowserWatcher } from './watch/browser.js';
import { resolveCore, resolveCoreSync, coreOptions, createDefaultsSource } from './resolve-core.js';
import { createSearchParamsSource } from './search-params.js';
import {
  createInjectedGlobalSource,
  createImportMetaEnvSource,
  createLocalStorageSource,
} from './sources/browser/index.js';
import { validateResolved, toPublic } from './validate.js';
import { defineConfig } from './tooling/define-config.js';
import { toJSONSchema } from './tooling/to-json-schema.js';
import type { z } from 'zod';
import type {
  EnvironmentalistOptions,
  Environment,
  SafeResult,
  Source,
  SourceName,
  SourceSpec,
} from './types.js';
import type { WatchOptions, Watcher } from './watch/watcher.js';

/** Browser source order, from per-navigation overrides to schema defaults. */
export const DEFAULT_BROWSER_SOURCE_NAMES = [
  'search-params',
  'injected-global',
  'local-storage',
  'import-meta-env',
  'defaults',
] as const satisfies readonly SourceName[];

type ImportMetaWithEnv = ImportMeta & { readonly env?: Record<string, unknown> };
const buildEnvironment = (import.meta as ImportMetaWithEnv).env;

function extrasFor(schema: z.ZodObject) {
  return {
    secretKeys: secretKeysOf(schema),
    envOverrides: envOverridesOf(schema),
    flagOverrides: flagOverridesOf(schema),
  } as const;
}

function browserSource(id: SourceName, schema: z.ZodObject): Source | undefined {
  switch (id) {
    case 'injected-global':
      return createInjectedGlobalSource();
    case 'local-storage':
      return createLocalStorageSource();
    case 'import-meta-env':
      return createImportMetaEnvSource(
        buildEnvironment === undefined ? {} : { env: buildEnvironment },
      );
    case 'defaults':
      return createDefaultsSource(schema);
    default:
      return undefined;
  }
}

function browserSourceChain<S extends z.ZodObject>(
  schema: S,
  options: EnvironmentalistOptions<S>,
): readonly Source[] {
  const specs: readonly SourceSpec[] = options.sources ?? DEFAULT_BROWSER_SOURCE_NAMES;
  const excluded = new Set(options.exclude ?? []);
  const sources: Source[] = [];
  for (const spec of specs) {
    if (typeof spec !== 'string') {
      sources.push(spec);
      continue;
    }
    if (excluded.has(spec)) continue;
    if (spec === 'search-params') {
      sources.push(
        options.search === undefined
          ? {
              id: 'search-params',
              kind: 'string',
              load: (context) => createSearchParamsSource().load(context),
              loadSync: (context) => createSearchParamsSource().loadSync?.(context),
            }
          : createSearchParamsSource({ search: options.search }),
      );
      continue;
    }
    const source = browserSource(spec, schema);
    if (source !== undefined) sources.push(source);
  }
  return sources;
}

function browserContext<S extends z.ZodObject>(options: EnvironmentalistOptions<S>, schema: S) {
  return {
    name: options.name,
    cwd: '/',
    mode: undefined,
    env: {},
    argv: [],
    envPrefix: options.envPrefix,
    secretKeys: secretKeysOf(schema),
    envOverrides: envOverridesOf(schema),
  } as const;
}

async function resolve<S extends z.ZodObject>(
  options: EnvironmentalistOptions<S>,
  sources: readonly Source[],
): Promise<Environment<S>> {
  const extras = extrasFor(options.schema);
  const resolved = await resolveCore(
    options.schema,
    coreOptions(options, '/'),
    sources,
    browserContext(options, options.schema),
    extras,
  );
  return validateResolved({ name: options.name, schema: options.schema, resolved });
}

function resolveSync<S extends z.ZodObject>(
  options: EnvironmentalistOptions<S>,
  sources: readonly Source[],
): Environment<S> {
  const extras = extrasFor(options.schema);
  const resolved = resolveCoreSync(
    options.schema,
    coreOptions(options, '/'),
    sources,
    browserContext(options, options.schema),
    extras,
  );
  return validateResolved({ name: options.name, schema: options.schema, resolved });
}

/** The browser resolver and its async, sync, safe, and watch helpers. */
export type BrowserEnvironmentalist = {
  <S extends z.ZodObject>(options: EnvironmentalistOptions<S>): Promise<Environment<S>>;
  safe: <S extends z.ZodObject>(options: EnvironmentalistOptions<S>) => Promise<SafeResult<S>>;
  sync: <S extends z.ZodObject>(options: EnvironmentalistOptions<S>) => Environment<S>;
  safeSync: <S extends z.ZodObject>(options: EnvironmentalistOptions<S>) => SafeResult<S>;
  watch: <S extends z.ZodObject>(
    options: EnvironmentalistOptions<S> & WatchOptions<S>,
  ) => Watcher<S>;
};

/** Resolve browser-safe configuration from URL, global, storage, build env, and defaults. */
export const environmentalist: BrowserEnvironmentalist = Object.assign(
  <S extends z.ZodObject>(options: EnvironmentalistOptions<S>) =>
    resolve(options, browserSourceChain(options.schema, options)),
  {
    safe: async <S extends z.ZodObject>(options: EnvironmentalistOptions<S>) => {
      try {
        const data = await resolve(options, browserSourceChain(options.schema, options));
        return { success: true, data } as const;
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof EnvironmentalistError
              ? error
              : new EnvironmentalistError(String(error)),
        } as const;
      }
    },
    sync: <S extends z.ZodObject>(options: EnvironmentalistOptions<S>) =>
      resolveSync(options, browserSourceChain(options.schema, options)),
    safeSync: <S extends z.ZodObject>(options: EnvironmentalistOptions<S>) => {
      try {
        const data = resolveSync(options, browserSourceChain(options.schema, options));
        return { success: true, data } as const;
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof EnvironmentalistError
              ? error
              : new EnvironmentalistError(String(error)),
        } as const;
      }
    },
    watch: <S extends z.ZodObject>(options: EnvironmentalistOptions<S> & WatchOptions<S>) =>
      createBrowserWatcher(options, browserSourceChain(options.schema, options)),
  },
);

/** Create a browser-native watcher directly. */
export function createWatcher<S extends z.ZodObject>(
  options: EnvironmentalistOptions<S> & WatchOptions<S>,
): Watcher<S> {
  return createBrowserWatcher(options, browserSourceChain(options.schema, options));
}

export { EnvironmentalistError, defineConfig, registry, secret, toJSONSchema, toPublic };
export { SCHEMA, SOURCES } from './types.js';
export type {
  CamelCasedPropertiesDeep,
  DeepPartial,
  EnvironmentalistOptions,
  Environment,
  SafeResult,
  SourceName,
  SourceSpec,
} from './types.js';
export type { WatchOptions, Watcher } from './watch/watcher.js';
