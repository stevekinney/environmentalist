import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createNodeWatcher, defaultWatchFile, nativeLocations } from './node.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Node watcher adapter', () => {
  it('watches and closes an existing file, and filters native locations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'environmentalist-watch-node-'));
    directories.push(directory);
    const location = join(directory, 'config.json');
    await writeFile(location, '{}');
    let calls = 0;
    let close: (() => void) | undefined;
    const changed = new Promise<void>((resolve, reject) => {
      close = defaultWatchFile(location, () => {
        calls += 1;
        resolve();
      });
      void writeFile(location, '{"changed":true}').catch(reject);
    });
    await changed;
    expect(calls).toBeGreaterThan(0);
    expect(nativeLocations({ source: 'config', location: ` ${location}, missing ` })).toEqual([
      location,
    ]);
    close?.();
    expect(calls).toBe(1);
  });

  it('uses the default Node resolver and scheduler when seams are omitted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'environmentalist-watch-node-'));
    directories.push(directory);
    const watcher = createNodeWatcher({
      name: 'app',
      schema: z.object({ VALUE: z.string() }),
      cwd: directory,
      root: directory,
      env: { VALUE: 'ok' },
      argv: [],
      exclude: [
        'dotenv',
        'project-config',
        'package-json',
        'user-dotfile',
        'xdg-config',
        'home-config',
      ],
    });
    await watcher.ready;
    expect(watcher.current.value).toBe('ok');
    await watcher.close();
  });
});
