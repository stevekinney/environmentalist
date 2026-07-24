/* eslint-disable max-lines, typescript/no-unsafe-type-assertion */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { EnvironmentalistOptions } from '../types.js';
import { createNodeWatcher as createWatcher } from './node.js';
import type { WatchOptions, Watcher } from './watcher.js';

const directories: string[] = [];
const watchers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'environmentalist-watch-'));
  directories.push(directory);
  return directory;
}

function options<S extends z.ZodObject>(
  cwd: string,
  schema: S,
  overrides: Partial<EnvironmentalistOptions<S> & WatchOptions<S>> = {},
): EnvironmentalistOptions<S> & WatchOptions<S> {
  return {
    name: 'app',
    schema,
    cwd,
    root: cwd,
    env: {},
    argv: [],
    exclude: [
      'project-config',
      'package-json',
      'user-dotfile',
      'xdg-config',
      'home-config',
    ] as const,
    ...overrides,
  };
}

function track<S extends z.ZodObject>(watcher: Watcher<S>): Watcher<S> {
  watchers.push(watcher);
  return watcher;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for watcher test state.');
}

describe('watcher', () => {
  it('emits dotenv changes with a provenance-backed diff', async () => {
    const cwd = await temporaryDirectory();
    const location = join(cwd, '.env');
    await writeFile(location, 'VALUE=one\n');
    const callbacks = new Map<string, () => void>();
    const watcher = track(
      createWatcher(
        options(cwd, z.object({ VALUE: z.string() }), {
          scheduleIdle: () => () => undefined,
          watchFile: (path, callback) => {
            callbacks.set(path, callback);
            return () => callbacks.delete(path);
          },
        }),
      ),
    );
    await watcher.ready;
    const change = new Promise<unknown>((resolve) => watcher.once('change', resolve));
    await writeFile(location, 'VALUE=two\n');
    callbacks.get(location)?.();
    const event = (await change) as {
      changes: readonly { key: string; from: unknown; to: unknown; source: string | undefined }[];
    };
    expect(event.changes).toContainEqual({
      key: 'value',
      from: 'one',
      to: 'two',
      source: 'dotenv',
    });
  });

  it('uses native file watching without polling, and polls env-only sources', async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, 'app.config.json'), '{"VALUE":"file"}');
    const watched: string[] = [];
    const idleCalls: (() => void)[] = [];
    const fileWatcher = track(
      createWatcher(
        options(cwd, z.object({ VALUE: z.string() }), {
          exclude: ['env', 'dotenv', 'package-json', 'user-dotfile', 'xdg-config', 'home-config'],
          scheduleIdle: (callback) => {
            idleCalls.push(callback);
            return () => undefined;
          },
          watchFile: (path) => {
            watched.push(path);
            return () => undefined;
          },
        }),
      ),
    );
    await fileWatcher.ready;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(watched).toContain(join(cwd, 'app.config.json'));
    expect(idleCalls).toHaveLength(0);

    const environment = { VALUE: 'env-one' };
    const envWatcher = track(
      createWatcher(
        options(cwd, z.object({ VALUE: z.string() }), {
          exclude: [
            'dotenv',
            'project-config',
            'package-json',
            'user-dotfile',
            'xdg-config',
            'home-config',
          ],
          env: environment,
          interval: 2,
          scheduleIdle: (callback) => {
            idleCalls.push(callback);
            return () => undefined;
          },
          watchFile: () => {
            throw new Error('env-only configuration should not use native file watching');
          },
        }),
      ),
    );
    await envWatcher.ready;
    await waitFor(() => idleCalls.length > 0);
    expect(idleCalls.length).toBeGreaterThan(0);
  });

  it('runs poll work through the injected idle scheduler and keeps no-op snapshots stable', async () => {
    const cwd = await temporaryDirectory();
    const environment = { VALUE: 'same' };
    const idleCalls: (() => void)[] = [];
    const watcher = track(
      createWatcher(
        options(cwd, z.object({ VALUE: z.string() }), {
          exclude: [
            'dotenv',
            'project-config',
            'package-json',
            'user-dotfile',
            'xdg-config',
            'home-config',
          ],
          env: environment,
          interval: 2,
          scheduleIdle: (callback) => {
            idleCalls.push(callback);
            return () => undefined;
          },
        }),
      ),
    );
    await watcher.ready;
    const snapshot = watcher.getSnapshot();
    await waitFor(() => idleCalls.length > 0);
    idleCalls.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(watcher.getSnapshot()).toBe(snapshot);
    await watcher.close();
  });

  it('keeps the last good environment after an invalid reload and recovers', async () => {
    const cwd = await temporaryDirectory();
    const location = join(cwd, '.env');
    await writeFile(location, 'PORT=3000\n');
    let callback: (() => void) | undefined;
    const watcher = track(
      createWatcher(
        options(cwd, z.object({ PORT: z.number() }), {
          watchFile: (_path, next) => {
            callback = next;
            return () => undefined;
          },
        }),
      ),
    );
    await watcher.ready;
    const previous = watcher.current;
    const errors: unknown[] = [];
    watcher.on('error', (error) => errors.push(error));
    await writeFile(location, 'PORT=not-a-number\n');
    callback?.();
    await waitFor(() => errors.length === 1);
    expect(watcher.current).toBe(previous);
    await writeFile(location, 'PORT=4000\n');
    const change = new Promise((resolve) => watcher.once('change', resolve));
    callback?.();
    await change;
    expect(watcher.current.port).toBe(4000);
  });

  it('coalesces rapid iterator updates to the newest snapshot', async () => {
    const cwd = await temporaryDirectory();
    const location = join(cwd, '.env');
    await writeFile(location, 'VALUE=one\n');
    let callback: (() => void) | undefined;
    const changes: unknown[] = [];
    const watcher = track(
      createWatcher(
        options(cwd, z.object({ VALUE: z.string() }), {
          watchFile: (_path, next) => {
            callback = next;
            return () => undefined;
          },
        }),
      ),
    );
    await watcher.ready;
    watcher.on('change', (event) => changes.push(event.environment));
    const iterator = watcher[Symbol.asyncIterator]();
    await writeFile(location, 'VALUE=two\n');
    callback?.();
    await waitFor(() => changes.length === 1);
    await writeFile(location, 'VALUE=three\n');
    callback?.();
    await waitFor(() => changes.length === 2);
    const result = await iterator.next();
    expect(result.value).toBe(changes[1]);
    const pending = iterator.next();
    await watcher.close();
    const pendingResult = await pending;
    expect(pendingResult.done).toBe(true);
  });

  it('closes native listeners and polling work, including await using', async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, 'app.config.json'), '{"VALUE":"file"}');
    let closeCount = 0;
    let cancelCount = 0;
    let emitCount = 0;
    {
      await using watcher = createWatcher(
        options(cwd, z.object({ VALUE: z.string() }), {
          exclude: ['env', 'dotenv', 'package-json', 'user-dotfile', 'xdg-config', 'home-config'],
          scheduleIdle: () => {
            return () => {
              cancelCount += 1;
            };
          },
          watchFile: () => {
            return () => {
              closeCount += 1;
            };
          },
        }),
      );
      watcher.on('change', () => {
        emitCount += 1;
      });
      await watcher.ready;
      await watcher.close();
      await watcher.close();
    }
    expect(closeCount).toBe(1);
    expect(cancelCount).toBe(0);
    expect(emitCount).toBe(0);
  });

  it('cancels scheduled polling when closed', async () => {
    const cwd = await temporaryDirectory();
    const idleCallbacks: Array<() => void> = [];
    let cancelCount = 0;
    const watcher = track(
      createWatcher(
        options(cwd, z.object({ VALUE: z.string() }), {
          env: { VALUE: 'poll' },
          strategy: 'poll',
          interval: 1,
          scheduleIdle: (callback) => {
            idleCallbacks.push(callback);
            return () => {
              cancelCount += 1;
            };
          },
        }),
      ),
    );
    await watcher.ready;
    await waitFor(() => idleCallbacks.length === 1);
    await watcher.close();
    const callbacksAfterClose = idleCallbacks.length;
    idleCallbacks[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 3));

    expect(cancelCount).toBe(1);
    expect(idleCallbacks).toHaveLength(callbacksAfterClose);
  });
});
