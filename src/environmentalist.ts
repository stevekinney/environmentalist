import { EnvironmentalistError } from './errors.js';
import { envOverridesOf, flagOverridesOf, secretKeysOf } from './metadata.js';
import { resolveRaw, resolveRawSync } from './resolve.js';
import { safeValidateResolved, validateResolved } from './validate.js';
import { initialize } from './tooling/initialize.js';
import { createNodeWatcher } from './watch/node.js';
import type { z } from 'zod';
import type { EnvironmentalistOptions, Environment, SafeResult } from './types.js';
import type { WatchOptions, Watcher } from './watch/watcher.js';

type ResolutionOptions<S extends z.ZodObject> = EnvironmentalistOptions<S>;

function extrasFor(schema: z.ZodObject) {
  return {
    secretKeys: secretKeysOf(schema),
    envOverrides: envOverridesOf(schema),
    flagOverrides: flagOverridesOf(schema),
  } as const;
}

function asEnvironmentalistError(error: unknown): EnvironmentalistError {
  if (error instanceof EnvironmentalistError) return error;
  if (error instanceof Error) return new EnvironmentalistError(error.message);
  return new EnvironmentalistError(String(error));
}

async function resolve<S extends z.ZodObject>(
  options: ResolutionOptions<S>,
): Promise<Environment<S>> {
  try {
    const resolved = await resolveRaw(options, extrasFor(options.schema));
    return validateResolved({ name: options.name, schema: options.schema, resolved });
  } catch (error) {
    throw asEnvironmentalistError(error);
  }
}

async function safeResolve<S extends z.ZodObject>(
  options: ResolutionOptions<S>,
): Promise<SafeResult<S>> {
  try {
    const resolved = await resolveRaw(options, extrasFor(options.schema));
    return safeValidateResolved({ name: options.name, schema: options.schema, resolved });
  } catch (error) {
    return { success: false, error: asEnvironmentalistError(error) };
  }
}

function resolveSync<S extends z.ZodObject>(options: ResolutionOptions<S>): Environment<S> {
  try {
    const resolved = resolveRawSync(options, extrasFor(options.schema));
    return validateResolved({ name: options.name, schema: options.schema, resolved });
  } catch (error) {
    throw asEnvironmentalistError(error);
  }
}

function safeResolveSync<S extends z.ZodObject>(options: ResolutionOptions<S>): SafeResult<S> {
  try {
    const resolved = resolveRawSync(options, extrasFor(options.schema));
    return safeValidateResolved({ name: options.name, schema: options.schema, resolved });
  } catch (error) {
    return { success: false, error: asEnvironmentalistError(error) };
  }
}

/** The callable Environmentalist resolver and its synchronous and tooling helpers. */
export type Environmentalist = {
  <S extends z.ZodObject>(options: ResolutionOptions<S>): Promise<Environment<S>>;
  /** Resolve configuration without throwing on schema or source failures. */
  safe: <S extends z.ZodObject>(options: ResolutionOptions<S>) => Promise<SafeResult<S>>;
  /** Resolve configuration synchronously. */
  sync: <S extends z.ZodObject>(options: ResolutionOptions<S>) => Environment<S>;
  /** Resolve configuration synchronously without throwing on failures. */
  safeSync: <S extends z.ZodObject>(options: ResolutionOptions<S>) => SafeResult<S>;
  /** Write a starter config file and optionally a .env.example. */
  initialize: typeof initialize;
  /** Watch for native or polled configuration changes. */
  watch: <S extends z.ZodObject>(options: ResolutionOptions<S> & WatchOptions<S>) => Watcher<S>;
};

/** Resolve a Zod configuration schema into a frozen, camelCase environment. */
const environmentalist: Environmentalist = Object.assign(
  <S extends z.ZodObject>(options: ResolutionOptions<S>) => resolve(options),
  {
    safe: <S extends z.ZodObject>(options: ResolutionOptions<S>) => safeResolve(options),
    sync: <S extends z.ZodObject>(options: ResolutionOptions<S>) => resolveSync(options),
    safeSync: <S extends z.ZodObject>(options: ResolutionOptions<S>) => safeResolveSync(options),
    initialize,
    watch: <S extends z.ZodObject>(options: ResolutionOptions<S> & WatchOptions<S>) =>
      createNodeWatcher(options),
  },
);

export { environmentalist };
