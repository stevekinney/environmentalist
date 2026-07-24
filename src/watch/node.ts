import { existsSync, watch } from 'node:fs';

import { envOverridesOf, flagOverridesOf, secretKeysOf } from '../metadata.js';
import { platform } from '../platform/node.js';
import { resolveRaw } from '../resolve.js';
import { validateResolved } from '../validate.js';
import type { EnvironmentalistOptions, Environment, Provenance } from '../types.js';
import { createWatcher } from './watcher.js';
import type { WatchOptions, Watcher } from './watcher.js';
import type { z } from 'zod';

/** Default native file watcher used by the Node adapter. */
export function defaultWatchFile(path: string, callback: () => void): () => void {
  const handle = watch(path, () => callback());
  return () => handle.close();
}

/** Return existing filesystem locations represented by a provenance entry. */
export function nativeLocations(provenance: Provenance): readonly string[] {
  return provenance.location
    .split(',')
    .map((location) => location.trim())
    .filter((location) => location.length > 0 && existsSync(location));
}

/** Create a watcher with the Node resolver, idle scheduler, and filesystem signal injected. */
export function createNodeWatcher<S extends z.ZodObject>(
  options: EnvironmentalistOptions<S> & WatchOptions<S>,
): Watcher<S> {
  const resolveEnvironment = async (): Promise<Environment<S>> => {
    const resolved = await resolveRaw(options, {
      secretKeys: secretKeysOf(options.schema),
      envOverrides: envOverridesOf(options.schema),
      flagOverrides: flagOverridesOf(options.schema),
    });
    return validateResolved({ name: options.name, schema: options.schema, resolved });
  };
  return createWatcher({
    ...options,
    resolve: options.resolve ?? resolveEnvironment,
    scheduleIdle: options.scheduleIdle ?? platform.scheduleIdle,
    watchFile: options.watchFile ?? defaultWatchFile,
    nativeLocations: options.nativeLocations ?? nativeLocations,
  });
}
