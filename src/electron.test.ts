import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createUserDataConfigSource, electronPaths } from './electron.js';
import { environmentalist } from './environmentalist.js';
import type { SourceContext } from './types.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'environmentalist-electron-'));
  directories.push(directory);
  return directory;
}

function context(name: string, cwd: string): SourceContext {
  return { name, cwd, mode: undefined, env: {}, argv: [], envPrefix: undefined };
}

describe('Electron helpers', () => {
  it('reproduces Electron application data locations on macOS, Windows, and Linux', () => {
    expect(electronPaths('Bowowwow', { platform: 'darwin', home: '/Users/test' })).toEqual({
      appData: '/Users/test/Library/Application Support',
      userData: '/Users/test/Library/Application Support/Bowowwow',
    });
    expect(
      electronPaths('Bowowwow', {
        platform: 'win32',
        home: 'C:\\Users\\test',
        env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
      }),
    ).toEqual({
      appData: 'C:\\Users\\test\\AppData\\Roaming',
      userData: 'C:\\Users\\test\\AppData\\Roaming\\Bowowwow',
    });
    expect(
      electronPaths('Bowowwow', {
        platform: 'linux',
        home: '/home/test',
        env: { XDG_CONFIG_HOME: '/tmp/config' },
      }),
    ).toEqual({ appData: '/tmp/config', userData: '/tmp/config/Bowowwow' });
    expect(
      electronPaths('Bowowwow', { platform: 'linux', home: '/home/test', env: {} }).userData,
    ).toBe('/home/test/.config/Bowowwow');
    expect(electronPaths('Bowowwow', { platform: 'aix', home: '/home/test', env: {} })).toEqual({
      appData: '/home/test/.config',
      userData: '/home/test/.config/Bowowwow',
    });
  });

  it('loads electron-store and app JSON files through a typed custom source', async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ API_KEY: 'from-store', port: 4310 }),
    );
    const schema = z.object({ API_KEY: z.string(), port: z.number() });
    const source = createUserDataConfigSource({ userData: directory, appName: 'Bowowwow' });
    const environment = await environmentalist({
      name: 'Bowowwow',
      schema,
      cwd: directory,
      env: {},
      argv: [],
      sources: [source],
    });

    expect(environment).toMatchObject({ apiKey: 'from-store', port: 4310 });
    expect(environment['apiKey']).toBe('from-store');
    const loaded = await source.load(context('Bowowwow', directory));
    expect(loaded?.values['apiKey']).toBe('from-store');
    expect(source.loadSync?.(context('Bowowwow', directory))?.values['port']).toBe(4310);
  });

  it('merges the named config and app JSON fallback formats', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'Bowowwow.config.json'), JSON.stringify({ FIRST: 'config' }));
    await writeFile(join(directory, 'Bowowwow.json'), JSON.stringify({ SECOND: 'app' }));
    const source = createUserDataConfigSource({ userData: directory, appName: 'Bowowwow' });
    const loaded = await source.load(context('Bowowwow', directory));
    expect(loaded?.values).toEqual({ first: 'config', second: 'app' });
  });

  it('returns undefined for missing and non-record user data in async and sync modes', async () => {
    const directory = await temporaryDirectory();
    const source = createUserDataConfigSource({ userData: directory, appName: 'App' });
    expect(await source.load(context('App', directory))).toBeUndefined();
    expect(source.loadSync?.(context('App', directory))).toBeUndefined();
    await writeFile(join(directory, 'config.json'), '[]');
    expect(await source.load(context('App', directory))).toBeUndefined();
    expect(source.loadSync?.(context('App', directory))).toBeUndefined();
  });
});
