import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import type { SourceContext } from '../../types.js';
import { createConfigLoader } from './loader.js';
import { loadStructuredFile, loadStructuredFileSync, parseUserDotfile } from './parsers.js';
import { nestRecord } from './helpers.js';
import { createHomeConfigSource, createUserDotfileSource, createXdgConfigSource } from './home.js';
import { createConfigFileSource } from './config-file.js';
import { createDotenvSource } from './dotenv.js';
import { createPackageJsonSource } from './package-json.js';
import { directoriesToWorkspaceRoot, findWorkspaceRoot } from './workspace.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'environmentalist-node-branches-'));
  directories.push(directory);
  return directory;
}

function context(home: string, name = 'app'): SourceContext {
  return { name, cwd: home, mode: undefined, env: {}, argv: [], envPrefix: undefined };
}

describe('runtime-aware loaders and parsers', () => {
  it('loads executable exports through custom and jiti loaders', async () => {
    const directory = await temporaryDirectory();
    const location = join(directory, 'custom.js');
    await writeFile(location, 'export default { VALUE: 1 };');
    const custom = createConfigLoader((path) => ({ VALUE: path.length }));
    expect(await custom.load(location)).toEqual({ VALUE: location.length });
    expect(custom.loadSync?.(location)).toEqual({ VALUE: location.length });
    const jiti = createConfigLoader('jiti');
    expect(await jiti.load(location)).toEqual({ VALUE: 1 });
    expect(jiti.loadSync?.(location)).toEqual({ default: { VALUE: 1 } });
    const commonJs = join(directory, 'common.cjs');
    await writeFile(commonJs, 'module.exports = { VALUE: 8 };');
    expect(await createConfigLoader('bun').load(commonJs)).toEqual({ VALUE: 8 });
    expect(createConfigLoader('bun').loadSync?.(commonJs)).toEqual({ VALUE: 8 });
    const typescript = join(directory, 'config.ts');
    await writeFile(typescript, 'export default { VALUE: 9 };');
    const originalBunVersion = process.versions['bun'];
    Reflect.deleteProperty(process.versions, 'bun');
    try {
      expect(() => createConfigLoader('bun').loadSync?.(typescript)).toThrow('requires Bun');
    } finally {
      Reflect.set(process.versions, 'bun', originalBunVersion);
    }
  });

  it('parses JSONC, TOML, YAML, dotenv-style dotfiles, and sync loader fallbacks', async () => {
    const directory = await temporaryDirectory();
    const jsonc = join(directory, 'values.jsonc');
    const toml = join(directory, 'values.toml');
    const yaml = join(directory, 'values.yml');
    await writeFile(jsonc, '{"url":"https://example.test/*", // comment\n"VALUE": 1 /* block */}');
    await writeFile(toml, 'VALUE = 2\n');
    await writeFile(yaml, 'VALUE: 3\n');
    const executable = {
      load: async () => ({ default: () => ({ VALUE: 4 }) }),
      loadSync: () => ({ default: { VALUE: 5 } }),
    };
    expect(await loadStructuredFile(jsonc, executable)).toEqual({
      url: 'https://example.test/*',
      VALUE: 1,
    });
    expect(await loadStructuredFile(toml, executable)).toEqual({ VALUE: 2 });
    expect(loadStructuredFileSync(yaml, executable)).toEqual({ VALUE: 3 });
    expect(await loadStructuredFile(join(directory, 'values.ts'), executable)).toEqual({
      VALUE: 4,
    });
    expect(loadStructuredFileSync(join(directory, 'values.ts'), executable)).toEqual({ VALUE: 5 });
    expect(
      loadStructuredFileSync(join(directory, 'values.ts'), { load: async () => ({}) }),
    ).toBeUndefined();
    expect(parseUserDotfile('{"VALUE": 6}')).toEqual({ VALUE: 6 });
    expect(parseUserDotfile('VALUE=7\n')).toEqual({ VALUE: '7' });
    expect(parseUserDotfile('[]')).toEqual({});
  });

  it('reuses existing nested records while normalizing flat entries', () => {
    expect(nestRecord({ server: { port: 1 }, 'server.host': 'example.test' })).toEqual({
      server: { port: 1, host: 'example.test' },
    });
  });
});

describe('home sources', () => {
  it('handles missing files and synchronous dotfile and XDG loading', async () => {
    const home = await temporaryDirectory();
    const missing = context(home, 'missing');
    const dot = createUserDotfileSource({ home });
    expect(await dot.load(missing)).toBeUndefined();
    expect(dot.loadSync?.(missing)).toBeUndefined();
    await writeFile(join(home, '.app'), '{"VALUE": 1}');
    expect(dot.loadSync?.(context(home))?.values).toEqual({ value: 1 });

    const xdg = join(home, 'xdg');
    await mkdir(join(xdg, 'app'), { recursive: true });
    await writeFile(join(xdg, 'app', 'config.yml'), 'VALUE: 2\n');
    const source = createXdgConfigSource({ home });
    const xdgContext = { ...context(home, 'app'), env: { XDG_CONFIG_HOME: xdg } };
    expect(await source.load(xdgContext)).toEqual({
      values: { value: 2 },
      location: join(xdg, 'app', 'config.yml'),
    });
    const asyncResult = await source.load(xdgContext);
    expect(source.loadSync?.(xdgContext)).toEqual(asyncResult);
    const missingResult = await source.load(context(home, 'missing'));
    expect(missingResult).toBeUndefined();
  });

  it('loads all managed home config filename variants and rejects non-record values', async () => {
    const home = await temporaryDirectory();
    const directory = join(home, '.environmentalist');
    await mkdir(directory);
    const source = createHomeConfigSource({ home });
    const managed = context(home);
    await writeFile(join(directory, 'app'), '{"VALUE": 1}');
    const extensionless = await source.load(managed);
    expect(extensionless?.values).toEqual({ value: 1 });
    expect(source.loadSync?.(managed)?.values).toEqual({ value: 1 });

    await rm(join(directory, 'app'));
    await writeFile(join(directory, 'app.json'), '{"VALUE": 2}');
    const regular = await source.load(managed);
    expect(regular?.values).toEqual({ value: 2 });
    await rm(join(directory, 'app.json'));
    await writeFile(join(directory, 'app.config.yaml'), 'VALUE: 3\n');
    expect(source.loadSync?.(managed)?.values).toEqual({ value: 3 });
    await rm(join(directory, 'app.config.yaml'));
    await writeFile(join(directory, 'app'), '[]');
    const nonRecordResult = await source.load(managed);
    expect(nonRecordResult).toBeUndefined();
    expect(source.loadSync?.(managed)).toBeUndefined();
  });
});

describe('empty and malformed Node source layers', () => {
  it('skips absent, empty, and non-record project and dotenv files', async () => {
    const directory = await temporaryDirectory();
    const project = createConfigFileSource({ root: directory });
    const sourceContext = context(directory);
    const missingProject = await project.load(sourceContext);
    expect(missingProject).toBeUndefined();
    expect(project.loadSync?.(sourceContext)).toBeUndefined();
    await writeFile(join(directory, 'app.config.json'), '[]');
    expect(await project.load(sourceContext)).toBeUndefined();
    expect(project.loadSync?.(sourceContext)).toBeUndefined();

    const dotenv = createDotenvSource();
    const missingDotenv = { ...sourceContext, cwd: join(directory, 'missing') };
    expect(await dotenv.load(missingDotenv)).toBeUndefined();
    expect(dotenv.loadSync?.(missingDotenv)).toBeUndefined();
    await writeFile(join(directory, '.env'), '\n');
    expect(await dotenv.load(sourceContext)).toBeUndefined();
    expect(dotenv.loadSync?.(sourceContext)).toBeUndefined();
  });

  it('continues past malformed and unrelated package manifests', async () => {
    const directory = await temporaryDirectory();
    const nested = join(directory, 'nested');
    await mkdir(nested);
    await writeFile(join(nested, 'package.json'), '{malformed');
    await writeFile(join(directory, 'package.json'), '{"other": {"VALUE": 1}}');
    const source = createPackageJsonSource({ root: directory });
    expect(await source.load(context(nested))).toBeUndefined();
    expect(source.loadSync?.(context(nested))).toBeUndefined();
  });
});

describe('workspace discovery', () => {
  it('detects workspaces packages, malformed packages, custom marker arrays, and roots', async () => {
    const root = await temporaryDirectory();
    const nested = join(root, 'packages', 'app');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'package.json'), '{"workspaces": {"packages": ["packages/*"]}}');
    expect(findWorkspaceRoot(nested)).toBe(root);
    expect(directoriesToWorkspaceRoot(nested)).toEqual([nested, join(root, 'packages'), root]);

    const malformed = await temporaryDirectory();
    const malformedNested = join(malformed, 'nested');
    await mkdir(malformedNested, { recursive: true });
    await writeFile(join(malformed, 'package.json'), '{malformed');
    const marker = join(malformed, '.root');
    await writeFile(marker, '');
    expect(findWorkspaceRoot(malformedNested, { stopAt: ['.root'] })).toBe(malformed);
    expect(findWorkspaceRoot(malformedNested, { root: malformed })).toBe(malformed);
    expect(findWorkspaceRoot(malformedNested, { root: root })).toBe(malformedNested);
    expect(findWorkspaceRoot(root, { root })).toBe(root);
    expect(directoriesToWorkspaceRoot('/')).toEqual(['/']);
    const unmarked = await temporaryDirectory();
    expect(findWorkspaceRoot(join(unmarked, 'nested'))).toBe('/');
    expect(findWorkspaceRoot(join(unmarked, 'nested'), { root: '/' })).toBe('/');
    expect(findWorkspaceRoot(join(root, 'packages', 'app'), { root: join(root, 'packages') })).toBe(
      join(root, 'packages'),
    );
    expect(directoriesToWorkspaceRoot(join(root, 'packages', 'app'), { root })).toEqual([
      join(root, 'packages', 'app'),
      join(root, 'packages'),
      root,
    ]);
    expect(
      directoriesToWorkspaceRoot(join(root, 'packages', 'app'), { root: join(root, 'packages') }),
    ).toEqual([join(root, 'packages', 'app'), join(root, 'packages')]);
  });
});
