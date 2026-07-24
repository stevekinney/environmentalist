import { parseFlags } from './flags.js';
import { canonicalizeKey, toEnvName } from './keys.js';
import {
  resolveCore,
  resolveCoreSync,
  coreOptions,
  guardSchema,
  schemaDefaults,
  schemaLeafPaths,
} from './resolve-core.js';
import { createSourceChain } from './source-chain.js';
import type { NodeSourceOptions } from './sources/node/index.js';
import type { EnvironmentalistOptions, SourceContext } from './types.js';
import type { z } from 'zod';
import type { ResolveExtras, ResolvedRaw } from './resolve-core.js';

/** Options accepted by the raw Node resolution composition. */
export type ResolveOptions<S extends z.ZodObject> = EnvironmentalistOptions<S> &
  Pick<NodeSourceOptions, 'home' | 'homeDirectory'>;

export type { ResolveExtras, ResolvedRaw } from './resolve-core.js';

export { guardSchema } from './resolve-core.js';

function modeValue(value: unknown): string | undefined {
  const selected = Array.isArray(value) ? value.at(-1) : value;
  return selected === undefined || selected === null ? undefined : String(selected);
}

function flagFactoryOverrides(
  schema: z.ZodObject,
  overrides: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const known = new Set(schemaLeafPaths(schema));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const canonicalKey = canonicalizeKey(key);
    if (known.has(canonicalKey) || known.has(canonicalKey.split('.')[0] ?? '')) {
      result[value] = canonicalKey;
    }
  }
  return result;
}

/** Resolve the mode key from flags, environment, or its schema default. */
// eslint-disable-next-line complexity
export function resolveMode<S extends z.ZodObject>(
  options: ResolveOptions<S>,
  extras: ResolveExtras = {},
): string | undefined {
  const modeKey = canonicalizeKey(options.modeKey ?? 'mode');
  const argv = options.argv ?? process.argv.slice(2);
  const flags = parseFlags(argv, {
    flagOverrides: flagFactoryOverrides(options.schema, extras.flagOverrides),
    ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
  });
  const flagMode = modeValue(valueAtPath(flags, modeKey));
  if (flagMode !== undefined) return flagMode;

  const env: Readonly<Record<string, string | undefined>> = options.env ?? process.env;
  const overrideName = extras.envOverrides?.[modeKey];
  if (overrideName !== undefined && env[overrideName] !== undefined) return env[overrideName];
  const envMode = env[toEnvName(modeKey, options.envPrefix)] ?? env['NODE_ENV'];
  if (envMode !== undefined) return envMode;

  return modeValue(schemaDefaults(options.schema)[modeKey]);
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = Object.hasOwn(current, segment) ? Reflect.get(current, segment) : undefined;
  }
  return current;
}

function contextFor<S extends z.ZodObject>(
  options: ResolveOptions<S>,
  mode: string | undefined,
  cwd: string,
  extras: ResolveExtras,
): SourceContext {
  return {
    name: options.name,
    cwd,
    mode,
    env: options.env ?? process.env,
    argv: options.argv ?? process.argv.slice(2),
    envPrefix: options.envPrefix,
    ...(extras.secretKeys === undefined ? {} : { secretKeys: extras.secretKeys }),
  };
}

/** Resolve all active Node sources asynchronously without schema validation. */
export async function resolveRaw<S extends z.ZodObject>(
  options: ResolveOptions<S>,
  extras: ResolveExtras = {},
): Promise<ResolvedRaw> {
  guardSchema(options.schema, options.name);
  const cwd = options.cwd ?? process.cwd();
  const mode = resolveMode(options, extras);
  const context = contextFor(options, mode, cwd, extras);
  const sources = createSourceChain(options.schema, options, extras);
  return resolveCore(options.schema, coreOptions(options, cwd), sources, context, extras);
}

/** Resolve all active synchronous Node sources without schema validation. */
export function resolveRawSync<S extends z.ZodObject>(
  options: ResolveOptions<S>,
  extras: ResolveExtras = {},
): ResolvedRaw {
  guardSchema(options.schema, options.name);
  const cwd = options.cwd ?? process.cwd();
  const mode = resolveMode(options, extras);
  const context = contextFor(options, mode, cwd, extras);
  const sources = createSourceChain(options.schema, options, extras);
  return resolveCoreSync(options.schema, coreOptions(options, cwd), sources, context, extras);
}
