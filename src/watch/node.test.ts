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
    let signalChange: (() => void) | undefined;
    const changed = new Promise<void>((resolve) => {
      signalChange = resolve;
    });
    const close = defaultWatchFile(location, () => {
      calls += 1;
      signalChange?.();
    });

    // fs.watch arms its subscription asynchronously, so a single write can land
    // before the watcher is listening and never produce an event. Keep writing
    // until one arrives rather than waiting longer on a write that was missed.
    const writes = setInterval(() => {
      void writeFile(location, `{"changed":${calls}}`).catch(() => undefined);
    }, 25);
    await changed;
    clearInterval(writes);

    expect(calls).toBeGreaterThan(0);
    expect(nativeLocations({ source: 'config', location: ` ${location}, missing ` })).toEqual([
      location,
    ]);

    close();
    const afterClose = calls;
    await writeFile(location, '{"after":true}');
    await Bun.sleep(50);
    expect(calls).toBe(afterClose);
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
