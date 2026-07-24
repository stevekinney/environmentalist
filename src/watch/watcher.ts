import { EnvironmentalistError } from '../errors.js';
import { SOURCES } from '../types.js';
import type { EnvironmentalistOptions, Environment, Provenance } from '../types.js';
import type { z } from 'zod';
import {
  asEnvironmentalistError,
  changedPaths,
  createIterator,
  deepEqual,
  initialChanges,
} from './helpers.js';
import type { StoredIterator } from './helpers.js';

/** How a watcher discovers changes after its initial resolution. */
export type WatchStrategy = 'auto' | 'poll';

/** Injectable Node seams and cadence controls for a watcher. */
export type WatchOptions<S extends z.ZodObject = z.ZodObject> = {
  readonly interval?: number;
  readonly strategy?: WatchStrategy;
  readonly signal?: AbortSignal;
  readonly emitInitial?: boolean;
  readonly equals?: (left: unknown, right: unknown) => boolean;
  readonly scheduleIdle?: (callback: () => void) => () => void;
  readonly watchFile?: (path: string, callback: () => void) => () => void;
  /** Inject the platform-specific resolver that feeds this neutral watcher. */
  readonly resolve?: () => Promise<Environment<S>>;
  /** Return native filesystem locations for a provenance entry, when supported. */
  readonly nativeLocations?: (provenance: Provenance) => readonly string[];
  /** Subscribe to a platform-native signal for a provenance entry, when supported. */
  readonly watchSource?: (provenance: Provenance, callback: () => void) => (() => void) | undefined;
  /** Keep polling alongside a native signal when same-context writes are invisible. */
  readonly pollWithNative?: (provenance: Provenance) => boolean;
};

/** One changed canonical configuration path. */
export type EnvironmentChange = {
  readonly key: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly source: string | undefined;
};

/** Payload emitted for each distinct valid environment transition. */
export type EnvironmentChangeEvent<S extends z.ZodObject> = {
  readonly environment: Environment<S>;
  readonly previous: Environment<S> | undefined;
  readonly changes: readonly EnvironmentChange[];
};

type WatchEventMap<S extends z.ZodObject> = {
  readonly change: EnvironmentChangeEvent<S>;
  readonly error: EnvironmentalistError;
  readonly close: undefined;
};

type Listener<S extends z.ZodObject, K extends keyof WatchEventMap<S>> = (
  payload: WatchEventMap<S>[K],
) => void;

/** A live, frozen environment snapshot with event, store, and iterator interfaces. */
export type Watcher<S extends z.ZodObject> = AsyncIterable<Environment<S>> &
  AsyncDisposable & {
    readonly current: Environment<S>;
    readonly ready: Promise<Environment<S>>;
    on<K extends keyof WatchEventMap<S>>(event: K, callback: Listener<S, K>): Watcher<S>;
    off<K extends keyof WatchEventMap<S>>(event: K, callback: Listener<S, K>): Watcher<S>;
    once<K extends keyof WatchEventMap<S>>(event: K, callback: Listener<S, K>): Watcher<S>;
    subscribe(this: void, callback: (environment: Environment<S>) => void): () => void;
    getSnapshot(this: void): Environment<S>;
    getServerSnapshot(this: void): Environment<S>;
    close(): Promise<void>;
  };

/** Create a live watcher over the same source and validation pipeline as the resolver. */
export function createWatcher<S extends z.ZodObject>(
  options: EnvironmentalistOptions<S> & WatchOptions<S>,
): Watcher<S> {
  const interval = options.interval ?? 1000;
  const strategy = options.strategy ?? 'auto';
  const equals = options.equals ?? deepEqual;
  const idleScheduler = options.scheduleIdle ?? scheduleIdle;
  const fileWatcher = options.watchFile;
  const listeners: {
    [K in keyof WatchEventMap<S>]: Set<Listener<S, K>>;
  } = {
    change: new Set(),
    error: new Set(),
    close: new Set(),
  };
  const subscribers = new Set<(environment: Environment<S>) => void>();
  const iterators = new Set<StoredIterator<S>>();
  const nativeUnsubscribers = new Map<string, () => void>();
  let current: Environment<S> | undefined;
  let initialError: EnvironmentalistError | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let idleCancel: (() => void) | undefined;
  let reloadRequested = false;
  let activeReload: Promise<void> | undefined;

  const emit = <K extends keyof WatchEventMap<S>>(event: K, payload: WatchEventMap<S>[K]): void => {
    for (const callback of Array.from(listeners[event])) {
      try {
        callback(payload);
      } catch {
        // Event listeners must not stop the watcher from resolving future changes.
      }
    }
  };

  const resolveEnvironment = async (): Promise<Environment<S>> => {
    if (options.resolve === undefined) {
      throw new EnvironmentalistError('A platform resolver must be injected into the watcher.');
    }
    return options.resolve();
  };

  const clearPolling = (): void => {
    if (pollTimer !== undefined) globalThis.clearTimeout(pollTimer);
    pollTimer = undefined;
    idleCancel?.();
    idleCancel = undefined;
  };

  // The source/provenance branches are intentionally kept together for native-first selection.
  // eslint-disable-next-line complexity
  const configureSignals = (environment: Environment<S>): void => {
    const wanted = new Set<string>();
    let shouldPoll = strategy === 'poll';
    for (const provenance of Object.values(environment[SOURCES])) {
      if (provenance === undefined) continue;
      if (strategy === 'auto') {
        const sourceKey = `source:${provenance.source}:${provenance.location}`;
        const existingSourceSignal = nativeUnsubscribers.get(sourceKey);
        if (existingSourceSignal !== undefined) {
          wanted.add(sourceKey);
          continue;
        }
        const sourceSignal = options.watchSource?.(provenance, () => requestReload());
        if (sourceSignal !== undefined) {
          nativeUnsubscribers.set(sourceKey, sourceSignal);
          wanted.add(sourceKey);
          if (options.pollWithNative?.(provenance) === true) shouldPoll = true;
          continue;
        }

        const paths = options.nativeLocations?.(provenance) ?? [];
        if (paths.length > 0 && fileWatcher !== undefined) {
          for (const path of paths) {
            const pathKey = `file:${path}`;
            wanted.add(pathKey);
            if (nativeUnsubscribers.has(pathKey)) continue;
            try {
              nativeUnsubscribers.set(
                pathKey,
                fileWatcher(path, () => requestReload()),
              );
            } catch {
              wanted.delete(pathKey);
              shouldPoll = true;
            }
          }
        } else {
          shouldPoll = true;
        }
      }
    }

    for (const [path, unsubscribe] of nativeUnsubscribers) {
      if (wanted.has(path)) continue;
      unsubscribe();
      nativeUnsubscribers.delete(path);
    }
    clearPolling();
    if (shouldPoll && !closed) schedulePoll();
  };

  const publish = (environment: Environment<S>, previous: Environment<S> | undefined): void => {
    if (closed) return;
    if (previous !== undefined && equals(previous, environment)) return;
    current = environment;
    const event: EnvironmentChangeEvent<S> = {
      environment,
      previous,
      changes:
        previous === undefined ? initialChanges(environment) : changedPaths(previous, environment),
    };
    emit('change', event);
    for (const subscriber of Array.from(subscribers)) subscriber(environment);
    for (const iterator of iterators) iterator.push(environment);
  };

  const reloadOnce = async (): Promise<void> => {
    try {
      const environment = await resolveEnvironment();
      if (closed) return;
      const previous = current;
      if (previous === undefined) {
        current = environment;
        configureSignals(environment);
        if (options.emitInitial === true) publish(environment, undefined);
      } else {
        publish(environment, previous);
        configureSignals(environment);
      }
    } catch (error) {
      const environmentalistError = asEnvironmentalistError(error);
      if (current === undefined) initialError = environmentalistError;
      if (!closed && current !== undefined) emit('error', environmentalistError);
      if (current === undefined) throw environmentalistError;
    }
  };

  const runReloads = async (): Promise<void> => {
    do {
      reloadRequested = false;
      await reloadOnce();
    } while (reloadRequested);
  };

  function requestReload(): void {
    if (closed) return;
    if (activeReload !== undefined) {
      reloadRequested = true;
      return;
    }
    const task = runReloads();
    activeReload = task;
    void task.then(() => {
      if (activeReload === task) activeReload = undefined;
      return undefined;
    });
  }

  function schedulePoll(): void {
    if (closed) return;
    pollTimer = globalThis.setTimeout(() => {
      pollTimer = undefined;
      if (closed) return;
      idleCancel = idleScheduler(() => {
        idleCancel = undefined;
        if (!closed) requestReload();
      });
      schedulePoll();
    }, interval);
  }

  const initialTask = (async (): Promise<Environment<S>> => {
    await reloadOnce();
    if (current === undefined) throw asEnvironmentalistError('Environment did not resolve.');
    return current;
  })();

  const removeIterator = (stored: StoredIterator<S>): void => {
    iterators.delete(stored);
  };

  const api: Watcher<S> = {
    get current(): Environment<S> {
      if (current !== undefined) return current;
      throw initialError ?? new EnvironmentalistError('Environment has not resolved yet.');
    },
    ready: initialTask,
    on<K extends keyof WatchEventMap<S>>(event: K, callback: Listener<S, K>): Watcher<S> {
      listeners[event].add(callback);
      return api;
    },
    off<K extends keyof WatchEventMap<S>>(event: K, callback: Listener<S, K>): Watcher<S> {
      listeners[event].delete(callback);
      return api;
    },
    once<K extends keyof WatchEventMap<S>>(event: K, callback: Listener<S, K>): Watcher<S> {
      const wrapped: Listener<S, K> = (payload) => {
        api.off(event, wrapped);
        callback(payload);
      };
      return api.on(event, wrapped);
    },
    subscribe(this: void, callback: (environment: Environment<S>) => void): () => void {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    getSnapshot(this: void): Environment<S> {
      return api.current;
    },
    getServerSnapshot(this: void): Environment<S> {
      return api.current;
    },
    [Symbol.asyncIterator](): AsyncIterator<Environment<S>> & AsyncIterable<Environment<S>> {
      const stored = createIterator(removeIterator);
      iterators.add(stored);
      return stored.iterator;
    },
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      clearPolling();
      for (const unsubscribe of nativeUnsubscribers.values()) unsubscribe();
      nativeUnsubscribers.clear();
      for (const iterator of Array.from(iterators)) iterator.finish();
      subscribers.clear();
      emit('close', undefined);
      closePromise = Promise.allSettled([initialTask, activeReload ?? Promise.resolve()]).then(
        () => undefined,
      );
      return closePromise;
    },
    [Symbol.asyncDispose](): Promise<void> {
      return api.close();
    },
  };

  if (options.signal !== undefined) {
    if (options.signal.aborted) void api.close();
    else options.signal.addEventListener('abort', () => void api.close(), { once: true });
  }

  return api;
}

export function scheduleIdle(callback: () => void): () => void {
  const handle = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(handle);
}
