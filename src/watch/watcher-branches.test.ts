/* eslint-disable typescript/no-unsafe-type-assertion */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { SOURCES } from '../types.js';
import type { Environment, Provenance } from '../types.js';
import { createBrowserWatcher, storageSignal } from './browser.js';
import { createWatcher, scheduleIdle } from './watcher.js';

const schema = z.object({ VALUE: z.string() });
type TestEnvironment = Environment<typeof schema>;

function environment(value: string, location: string, source = 'custom'): TestEnvironment {
  const result = { value } as unknown as TestEnvironment;
  Object.defineProperty(result, SOURCES, {
    value: { value: { source, location } satisfies Provenance },
  });
  return result;
}

describe('watcher signal and lifecycle branches', () => {
  it('cancels the default watcher idle handle', () => {
    scheduleIdle(() => undefined)();
  });

  it('supports initial events, subscribers, once listeners, and native source signals', async () => {
    let value = 'one';
    let trigger: (() => void) | undefined;
    let unsubscribeCount = 0;
    let subscriberCount = 0;
    let onceCount = 0;
    const closeEvents: unknown[] = [];
    const watcher = createWatcher({
      name: 'app',
      schema,
      resolve: async () => environment(value, `${value}-location`),
      emitInitial: true,
      scheduleIdle: () => () => undefined,
      watchSource: (_provenance, callback) => {
        trigger = callback;
        return () => {
          unsubscribeCount += 1;
        };
      },
      pollWithNative: () => true,
    });
    watcher.on('change', () => {
      throw new Error('listeners are isolated');
    });
    watcher.once('change', () => {
      onceCount += 1;
    });
    const unsubscribe = watcher.subscribe(() => {
      subscriberCount += 1;
    });
    watcher.on('close', (payload) => closeEvents.push(payload));
    await watcher.ready;
    expect(watcher.getSnapshot()).toBe(watcher.getServerSnapshot());
    expect(onceCount).toBe(1);
    expect(subscriberCount).toBe(1);

    value = 'two';
    trigger?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(watcher.current.value).toBe('two');
    expect(onceCount).toBe(1);
    expect(subscriberCount).toBe(2);
    unsubscribe();
    watcher.off('change', () => undefined);
    await watcher.close();
    expect(unsubscribeCount).toBe(2);
    expect(closeEvents).toEqual([undefined]);
  });

  it('falls back to polling when a native file watcher fails', async () => {
    const idleCallbacks: Array<() => void> = [];
    const watcher = createWatcher({
      name: 'app',
      schema,
      resolve: async () => environment('one', 'old-location'),
      nativeLocations: () => ['one', 'two'],
      watchFile: (path) => {
        if (path === 'two') throw new Error('watch failed');
        return () => undefined;
      },
      interval: 1,
      scheduleIdle: (callback) => {
        idleCallbacks.push(callback);
        return () => undefined;
      },
    });
    await watcher.ready;
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(idleCallbacks.length).toBeGreaterThan(0);
    await watcher.close();
  });

  it('reports missing platform resolvers and handles abort before and after startup', async () => {
    const missing = createWatcher({ name: 'app', schema });
    try {
      await missing.ready;
    } catch (error) {
      expect(error).toHaveProperty('message', expect.stringContaining('platform resolver'));
    }
    expect(() => missing.current).toThrow('platform resolver');
    await missing.close();

    const earlyController = new AbortController();
    const early = createWatcher({
      name: 'app',
      schema,
      resolve: async () => environment('early', 'early'),
      signal: earlyController.signal,
    });
    earlyController.abort();
    await early.close();

    const controller = new AbortController();
    const watcher = createWatcher({
      name: 'app',
      schema,
      resolve: async () => environment('ready', 'ready'),
      signal: controller.signal,
    });
    await watcher.ready;
    controller.abort();
    await watcher.close();
  });

  it('guards access before a delayed initial resolution', async () => {
    let release: (() => void) | undefined;
    const watcher = createWatcher({
      name: 'app',
      schema,
      resolve: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return environment('delayed', 'delayed');
      },
    });
    expect(() => watcher.current).toThrow('not resolved');
    release?.();
    await watcher.ready;
    await watcher.close();
  });

  it('replays a reload requested while another reload is active', async () => {
    let value = 'one';
    let release: (() => void) | undefined;
    let trigger: (() => void) | undefined;
    let calls = 0;
    const watcher = createWatcher({
      name: 'app',
      schema,
      resolve: async () => {
        calls += 1;
        if (calls === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return environment(value, `${value}-location`);
      },
      watchSource: (_provenance, callback) => {
        trigger = callback;
        return () => undefined;
      },
    });
    await watcher.ready;
    value = 'two';
    trigger?.();
    trigger?.();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(watcher.current.value).toBe('two');
    expect(calls).toBe(3);
    await watcher.close();
  });

  it('uses the watcher timeout scheduler when polling is not injected', async () => {
    const watcher = createWatcher({
      name: 'app',
      schema,
      strategy: 'poll',
      interval: 1,
      resolve: async () => environment('poll', 'poll'),
    });
    await watcher.ready;
    await new Promise((resolve) => setTimeout(resolve, 4));
    await watcher.close();
  });

  it('removes an iterator explicitly before closing', async () => {
    const watcher = createWatcher({
      name: 'app',
      schema,
      resolve: async () => environment('value', 'location'),
    });
    await watcher.ready;
    const closeListener = (_payload: undefined) => {
      void watcher;
    };
    watcher
      .on('close', closeListener)
      .once('close', () => undefined)
      .off('close', closeListener);
    const iterator = watcher[Symbol.asyncIterator]();
    await iterator.return?.();
    const close = watcher.close();
    expect(watcher.close()).toBe(close);
    await close;
    await watcher[Symbol.asyncDispose]();
  });

  it('handles browser storage signals when the event target is unavailable', async () => {
    const originalAdd = globalThis.addEventListener;
    const originalRemove = globalThis.removeEventListener;
    Reflect.deleteProperty(globalThis, 'addEventListener');
    Reflect.deleteProperty(globalThis, 'removeEventListener');
    try {
      expect(
        storageSignal({ source: 'local-storage', location: 'localStorage:app' }, () => undefined),
      ).toBeUndefined();
    } finally {
      Reflect.set(globalThis, 'addEventListener', originalAdd);
      Reflect.set(globalThis, 'removeEventListener', originalRemove);
    }
    const localStorageEnvironment = environment('value', 'localStorage:app', 'local-storage');
    const watcher = createBrowserWatcher(
      {
        name: 'app',
        schema,
        resolve: async () => localStorageEnvironment,
        scheduleIdle: () => () => undefined,
      },
      [],
    );
    await watcher.ready;
    await watcher.close();
  });
});
