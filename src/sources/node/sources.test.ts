import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import type { SourceContext } from '../../types.js';
import {
  createConfigFileSource,
  createDotenvSource,
  createEnvSource,
  createHomeConfigSource,
  createPackageJsonSource,
  createUserDotfileSource,
  createXdgConfigSource,
  envNameFor,
  findWorkspaceRoot,
} from './index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'environmentalist-'));
  directories.push(directory);
  return directory;
}

function context(cwd: string, overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    name: 'app',
    cwd,
    mode: undefined,
    env: {},
    argv: [],
    envPrefix: undefined,
    ...overrides,
  };
}

describe('environment source', () => {
  it('claims prefixed variables and maps double underscores to nesting', async () => {
    const source = createEnvSource({ envPrefix: 'APP' });
    const result = await source.load(
      context('/', {
        env: {
          APP_SERVER__PORT: '3000',
          APP_API_KEY: 'secret',
          SERVER__PORT: 'ignored',
        },
      }),
    );

    expect(result).toEqual({
      values: { server: { port: '3000' }, apiKey: 'secret' },
      location: 'process.env',
    });
    expect(envNameFor('server.port', 'app')).toBe('APP_SERVER__PORT');
  });

  it('claims every defined variable without a prefix and supports sync loading', () => {
    const source = createEnvSource();
    const result = source.loadSync?.(context('/', { env: { PORT: '3000', EMPTY: undefined } }));
    expect(result?.values).toEqual({ port: '3000' });
  });

  it('skips ambient variables whose names cannot round-trip', () => {
    const source = createEnvSource();
    const result = source.loadSync?.(
      context('/', {
        env: {
          // macOS exports these into every shell; `__` becomes a nesting dot,
          // which used to produce an unrepresentable leading-dot key and throw.
          __CF_USER_TEXT_ENCODING: '0x0:0:0',
          __CFBundleIdentifier: 'com.apple.Terminal',
          _: '/usr/bin/printenv',
          'BASH_FUNC_x%%': '() { echo; }',
          PORT: '3000',
        },
      }),
    );

    expect(result?.values).toEqual({ port: '3000' });
  });

  it('reports no result when every ambient variable is skipped', () => {
    const source = createEnvSource();
    const result = source.loadSync?.(context('/', { env: { __CF_USER_TEXT_ENCODING: '0x0:0:0' } }));

    expect(result).toBeUndefined();
  });
});

describe('dotenv source', () => {
  it('loads the mode cascade with isolated expansion and specific-file precedence', async () => {
    const cwd = await temporaryDirectory();
    await writeFile(
      join(cwd, '.env.production.local'),
      'BASE=production\nSHARED=specific\nEXPANDED=${BASE}\n',
    );
    await writeFile(join(cwd, '.env.local'), 'SHARED=local\nLOCAL=yes\n');
    await writeFile(join(cwd, '.env.production'), 'SHARED=mode\nMODE_ONLY=mode\n');
    await writeFile(join(cwd, '.env'), 'SHARED=base\nBASE_ONLY=base\n');

    const source = createDotenvSource();
    const result = await source.load(context(cwd, { mode: 'production' }));

    expect(result?.values).toEqual({
      base: 'production',
      shared: 'specific',
      expanded: 'production',
      local: 'yes',
      modeOnly: 'mode',
      baseOnly: 'base',
    });
    expect(result?.location).toContain('.env.production.local');
    expect(source.loadSync?.(context(cwd, { mode: 'production' }))).toEqual(result);
  });

  it('skips mode files when mode is absent', async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, '.env.local'), 'LOCAL=local\n');
    await writeFile(join(cwd, '.env.production'), 'MODE=wrong\n');
    const result = await createDotenvSource().load(context(cwd));
    expect(result?.values).toEqual({ local: 'local' });
  });

  it('reports no result when every declared name is skipped', async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, '.env'), '__LEADING=value\n');
    const result = await createDotenvSource().load(context(cwd));
    expect(result).toBeUndefined();
  });
});

describe('project config source', () => {
  it('merges nearest layers, stops at the supplied root, and loads JSON', async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, 'workspace');
    const child = join(root, 'packages', 'app');
    await mkdir(child, { recursive: true });
    await writeFile(join(parent, 'app.config.json'), '{"outside": true}');
    await writeFile(join(root, 'app.config.json'), '{"shared": "root", "rootOnly": true}');
    await writeFile(join(child, 'app.config.json'), '{"shared": "child", "childOnly": true}');

    const result = await createConfigFileSource({ root }).load(context(child));
    expect(result?.values).toEqual({ shared: 'child', childOnly: true, rootOnly: true });
    expect(result?.location).toBe(join(child, 'app.config.json'));
  });

  it('loads TypeScript, JavaScript, TOML, and YAML files', async () => {
    const extensions = [
      ['.ts', 'export default { VALUE: 1 };', 1],
      ['.js', 'export default { VALUE: 2 };', 2],
      ['.toml', 'VALUE = 3\n', 3],
      ['.yaml', 'VALUE: 4\n', 4],
    ] as const;

    for (const [extension, contents, expected] of extensions) {
      const cwd = await temporaryDirectory();
      await writeFile(join(cwd, `app.config${extension}`), contents);
      const result = await createConfigFileSource({ root: cwd }).load(context(cwd));
      expect(result?.values).toEqual({ value: expected });
    }
  });

  it('calls function exports and exposes a synchronous loader', async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, 'app.config.js'), 'export default () => ({ PORT: 4000 });');
    const source = createConfigFileSource({ root: cwd });
    const result = await source.load(context(cwd));
    expect(result?.values).toEqual({ port: 4000 });
    expect(source.loadSync?.(context(cwd))?.values).toEqual({ port: 4000 });
  });
});

describe('package and home sources', () => {
  it('reads the named package.json key', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'nested');
    await mkdir(cwd);
    await writeFile(join(root, 'package.json'), '{"app": {"PORT": 1234}}');
    const result = await createPackageJsonSource({ root }).load(context(cwd));
    expect(result?.values).toEqual({ port: 1234 });
  });

  it('loads all three injectable home locations', async () => {
    const home = await temporaryDirectory();
    const xdg = join(home, 'custom-xdg');
    await mkdir(join(xdg, 'xdg-app'), { recursive: true });
    await mkdir(join(home, '.environmentalist'), { recursive: true });
    await writeFile(join(home, '.dot-app'), 'PORT=1000\n');
    await writeFile(join(xdg, 'xdg-app', 'config.json'), '{"PORT": 2000}');
    await writeFile(join(home, '.environmentalist', 'home-app'), '{"PORT": 3000}');

    const dot = await createUserDotfileSource({ home }).load(context(home, { name: 'dot-app' }));
    const xdgResult = await createXdgConfigSource({ home }).load(
      context(home, {
        name: 'xdg-app',
        env: { XDG_CONFIG_HOME: xdg },
      }),
    );
    const managed = await createHomeConfigSource({ home }).load(
      context(home, { name: 'home-app' }),
    );

    expect(dot?.values).toEqual({ port: '1000' });
    expect(xdgResult?.values).toEqual({ port: 2000 });
    expect(managed?.values).toEqual({ port: 3000 });
  });
});

describe('workspace detection', () => {
  it('finds lockfile roots and honors custom stop markers', async () => {
    const root = await temporaryDirectory();
    const nested = join(root, 'a', 'b');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'bun.lock'), '');
    expect(findWorkspaceRoot(nested)).toBe(root);

    const customRoot = await temporaryDirectory();
    const customNested = join(customRoot, 'nested');
    await mkdir(customNested, { recursive: true });
    await writeFile(join(customRoot, '.workspace-root'), '');
    expect(findWorkspaceRoot(customNested, { stopAt: '.workspace-root' })).toBe(customRoot);
  });
});
