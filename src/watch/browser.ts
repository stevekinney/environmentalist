import { envOverridesOf, flagOverridesOf, secretKeysOf } from '../metadata.js';
import { platform } from '../platform/browser.js';
import { resolveCore, coreOptions } from '../resolve-core.js';
import { validateResolved } from '../validate.js';
import type { EnvironmentalistOptions, Environment, Provenance, Source } from '../types.js';
import { createWatcher } from './watcher.js';
import type { WatchOptions, Watcher } from './watcher.js';
import type { z } from 'zod';

type StorageEventTarget = {
  readonly addEventListener?: (type: string, listener: (event: Event) => void) => void;
  readonly removeEventListener?: (type: string, listener: (event: Event) => void) => void;
};

export function storageSignal(
  provenance: Provenance,
  callback: () => void,
): (() => void) | undefined {
  if (provenance.source !== 'local-storage') return undefined;
  const target = globalThis as typeof globalThis & StorageEventTarget;
  if (target.addEventListener === undefined || target.removeEventListener === undefined) {
    return undefined;
  }
  const expectedKey = provenance.location.startsWith('localStorage:')
    ? `environmentalist:${provenance.location.slice('localStorage:'.length)}`
    : undefined;
  const listener = (event: Event): void => {
    const key = Reflect.get(event, 'key');
    if (key === null || key === expectedKey) callback();
  };
  target.addEventListener('storage', listener);
  return () => target.removeEventListener?.('storage', listener);
}

/** Create a watcher using browser idle scheduling and localStorage storage events. */
export function createBrowserWatcher<S extends z.ZodObject>(
  options: EnvironmentalistOptions<S> & WatchOptions<S>,
  sources: readonly Source[],
): Watcher<S> {
  const resolveEnvironment = async (): Promise<Environment<S>> => {
    const context = {
      name: options.name,
      cwd: '/',
      mode: undefined,
      env: {},
      argv: [],
      envPrefix: options.envPrefix,
      secretKeys: secretKeysOf(options.schema),
    } as const;
    const resolved = await resolveCore(
      options.schema,
      coreOptions(options, '/'),
      sources,
      context,
      {
        secretKeys: secretKeysOf(options.schema),
        envOverrides: envOverridesOf(options.schema),
        flagOverrides: flagOverridesOf(options.schema),
      },
    );
    return validateResolved({ name: options.name, schema: options.schema, resolved });
  };
  return createWatcher({
    ...options,
    resolve: options.resolve ?? resolveEnvironment,
    scheduleIdle: options.scheduleIdle ?? platform.scheduleIdle,
    watchSource: options.watchSource ?? storageSignal,
    pollWithNative:
      options.pollWithNative ?? ((provenance) => provenance.source === 'local-storage'),
  });
}
