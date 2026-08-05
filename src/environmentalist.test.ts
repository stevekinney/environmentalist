/* eslint-disable max-lines */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { EnvironmentalistError, SCHEMA, SOURCES, environmentalist, secret } from './index.js';
import type { EnvironmentalistOptions } from './index.js';
import { createDefaultsSource } from './source-chain.js';
import {
  createHomeConfigSource,
  createUserDotfileSource,
  createXdgConfigSource,
} from './sources/node/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'environmentalist-acceptance-'));
  directories.push(directory);
  return directory;
}

function options<S extends z.ZodObject>(
  cwd: string,
  schema: S,
  overrides: Record<string, unknown> = {},
) {
  return {
    name: 'app',
    schema,
    cwd,
    root: cwd,
    env: {},
    argv: [],
    exclude: [
      'dotenv',
      'project-config',
      'package-json',
      'user-dotfile',
      'xdg-config',
      'home-config',
    ],
    ...overrides,
  } as EnvironmentalistOptions<S>;
}

describe('environmentalist public resolver', () => {
  it('camel-cases schema keys, freezes the result, and keeps symbols private', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({ ANTHROPIC_API_KEY: z.string() });
    const environment = await environmentalist(
      options(cwd, schema, { env: { ANTHROPIC_API_KEY: 'key' } }),
    );

    const camelCaseKey: string = environment.anthropicApiKey;
    void camelCaseKey;
    // @ts-expect-error the public environment uses canonical camelCase keys
    environment.ANTHROPIC_API_KEY;
    expect(environment.anthropicApiKey).toBe('key');
    expect((environment as Record<string, unknown>)['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(Object.isFrozen(environment)).toBe(true);
    expect(environment[SCHEMA]).toBe(schema);
    expect(environment[SOURCES].anthropicApiKey?.source).toBe('env');
  });

  it('accepts all three config-file key spellings', async () => {
    const spellings = ['anthropicApiKey', 'ANTHROPIC_API_KEY', 'anthropic-api-key'];
    for (const spelling of spellings) {
      const cwd = await temporaryDirectory();
      await writeFile(join(cwd, 'app.config.json'), JSON.stringify({ [spelling]: 'value' }));
      const schema = z.object({ ANTHROPIC_API_KEY: z.string() });
      const environment = await environmentalist({
        ...options(cwd, schema),
        exclude: ['env', 'dotenv', 'package-json', 'user-dotfile', 'xdg-config', 'home-config'],
      });
      expect(environment.anthropicApiKey).toBe('value');
    }
  });

  it('applies flag over env over dotenv and composes keys across sources', async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, '.env'), 'VALUE=dotenv\nDOTENV_ONLY=yes\n');
    const schema = z.object({ value: z.string(), dotenvOnly: z.string(), configOnly: z.string() });
    await writeFile(join(cwd, 'app.config.json'), '{"VALUE":"config","CONFIG_ONLY":"config"}');
    const environment = await environmentalist({
      ...options(cwd, schema),
      exclude: ['package-json', 'user-dotfile', 'xdg-config', 'home-config'],
      env: { VALUE: 'env' },
      argv: ['--value', 'flag'],
    });

    expect(environment).toMatchObject({ value: 'flag', dotenvOnly: 'yes', configOnly: 'config' });
    expect(environment[SOURCES].value?.source).toBe('flags');
    expect(environment[SOURCES].configOnly?.source).toBe('project-config');
  });

  it('lets a real environment variable beat dotenv without a flag for that key', async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, '.env'), 'VALUE=dotenv\n');
    const schema = z.object({ VALUE: z.string() });
    const environment = await environmentalist({
      ...options(cwd, schema, { env: { VALUE: 'environment' }, argv: [] }),
      exclude: ['project-config', 'package-json', 'user-dotfile', 'xdg-config', 'home-config'],
    });

    expect(environment.value).toBe('environment');
    expect(environment[SOURCES].value?.source).toBe('env');

    const excluded = await environmentalist({
      ...options(cwd, schema, { env: { VALUE: 'excluded' } }),
      exclude: [
        'env',
        'project-config',
        'package-json',
        'user-dotfile',
        'xdg-config',
        'home-config',
      ],
    });
    expect(excluded.value).toBe('dotenv');
    expect(Object.values(excluded[SOURCES]).every((source) => source?.source !== 'env')).toBe(true);
  });

  it('loads dotenv cascade files from most specific to least specific', async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, '.env'), 'VALUE=base\nBASE_ONLY=base\n');
    await writeFile(join(cwd, '.env.production'), 'VALUE=mode\nMODE_ONLY=mode\n');
    await writeFile(join(cwd, '.env.local'), 'VALUE=local\nLOCAL_ONLY=local\n');
    await writeFile(join(cwd, '.env.production.local'), 'VALUE=specific\nSPECIFIC_ONLY=specific\n');
    const schema = z.object({
      mode: z.string().default('development'),
      value: z.string(),
      baseOnly: z.string(),
      modeOnly: z.string(),
      localOnly: z.string(),
      specificOnly: z.string(),
    });
    const environment = await environmentalist({
      ...options(cwd, schema),
      exclude: [
        'env',
        'project-config',
        'package-json',
        'user-dotfile',
        'xdg-config',
        'home-config',
      ],
      argv: ['--mode', 'production'],
    });
    expect(environment).toMatchObject({
      mode: 'production',
      value: 'specific',
      baseOnly: 'base',
      modeOnly: 'mode',
      localOnly: 'local',
      specificOnly: 'specific',
    });
  });

  it('lets nearer project config override workspace-root config and stops at the root', async () => {
    const outside = await temporaryDirectory();
    const root = join(outside, 'workspace');
    const child = join(root, 'packages', 'app');
    await mkdir(child, { recursive: true });
    await writeFile(join(outside, 'app.config.json'), '{"value":"outside"}');
    await writeFile(join(root, 'app.config.json'), '{"value":"workspace","workspaceOnly":true}');
    await writeFile(join(child, 'app.config.json'), '{"value":"near","nearOnly":true}');
    const schema = z.object({
      value: z.string(),
      workspaceOnly: z.boolean(),
      nearOnly: z.boolean(),
      outsideOnly: z.string().default('default'),
    });
    const environment = await environmentalist({
      ...options(child, schema),
      root,
      exclude: ['env', 'dotenv', 'package-json', 'user-dotfile', 'xdg-config', 'home-config'],
    });
    expect(environment).toMatchObject({
      value: 'near',
      workspaceOnly: true,
      nearOnly: true,
      outsideOnly: 'default',
    });
  });

  it('loads TypeScript, JavaScript, JSON, TOML, and YAML project configs', async () => {
    const fixtures = [
      ['.ts', 'export default { VALUE: 1 };', 1],
      ['.js', 'export default { VALUE: 2 };', 2],
      ['.json', '{"VALUE":3}', 3],
      ['.toml', 'VALUE = 4\n', 4],
      ['.yaml', 'VALUE: 5\n', 5],
    ] as const;
    for (const [extension, contents, expected] of fixtures) {
      const cwd = await temporaryDirectory();
      await writeFile(join(cwd, `app.config${extension}`), contents);
      const schema = z.object({ VALUE: z.number() });
      const environment = await environmentalist({
        ...options(cwd, schema),
        exclude: ['env', 'dotenv', 'package-json', 'user-dotfile', 'xdg-config', 'home-config'],
      });
      expect(environment.value).toBe(expected);
    }
  });

  it('orders project, user, xdg, home, and default sources', async () => {
    const cwd = await temporaryDirectory();
    const home = await temporaryDirectory();
    const xdg = join(home, 'xdg');
    await mkdir(join(xdg, 'app'), { recursive: true });
    await mkdir(join(home, '.environmentalist'), { recursive: true });
    await writeFile(join(home, '.app'), 'USER=user\nVALUE=user\n');
    await writeFile(join(xdg, 'app', 'config.json'), '{"XDG":"xdg","VALUE":"xdg"}');
    await writeFile(
      join(home, '.environmentalist', 'app'),
      '{"HOME_CONFIG":"home","VALUE":"home"}',
    );
    await writeFile(join(cwd, 'app.config.json'), '{"project":"project","VALUE":"project"}');
    const schema = z.object({
      project: z.string(),
      user: z.string(),
      xdg: z.string(),
      homeConfig: z.string(),
      value: z.string().default('default'),
      fallback: z.string().default('default'),
    });
    const environment = await environmentalist({
      ...options(cwd, schema, {
        env: { XDG_CONFIG_HOME: xdg },
        exclude: ['dotenv', 'package-json'],
      }),
      sources: [
        'flags',
        'env',
        'project-config',
        createUserDotfileSource({ home }),
        createXdgConfigSource({ home }),
        createHomeConfigSource({ home }),
        createDefaultsSource(schema),
      ],
    });
    expect(environment).toMatchObject({
      project: 'project',
      user: 'user',
      xdg: 'xdg',
      homeConfig: 'home',
      fallback: 'default',
      value: 'project',
    });
    expect(environment[SOURCES].value?.source).toBe('project-config');
  });

  it('reports project config filename spellings for missing required keys', async () => {
    const cwd = await temporaryDirectory();
    const result = await environmentalist.safe({
      ...options(cwd, z.object({ REQUIRED: z.string() })),
      exclude: ['env', 'dotenv', 'package-json', 'user-dotfile', 'xdg-config', 'home-config'],
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('app.config');
  });

  it('supports prefixes, nested env keys, arrays, search params, and secret omission', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({
      server: z.object({ port: z.number() }),
      tags: z.array(z.string()),
      API_KEY: secret(z.string()),
    });
    const environment = await environmentalist({
      ...options(cwd, schema),
      envPrefix: 'APP',
      env: { APP_SERVER__PORT: '8080', APP_API_KEY: 'env-secret' },
      search: '?tags=one&tags=two&api-key=url-secret',
      exclude: [
        'dotenv',
        'project-config',
        'package-json',
        'user-dotfile',
        'xdg-config',
        'home-config',
      ],
    });
    expect(environment.server.port).toBe(8080);
    expect(environment.tags).toEqual(['one', 'two']);
    expect(environment.apiKey).toBe('env-secret');
  });

  it('supports exclusion, interpolation, package.json, and flag-selected dotenv mode', async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, '.env.production'), 'BASE=base\nEXPANDED=${BASE}-expanded\n');
    await writeFile(join(cwd, 'package.json'), '{"app":{"PACKAGE":"package"}}');
    const schema = z.object({
      base: z.string(),
      expanded: z.string(),
      package: z.string(),
      defaulted: z.string().default('default'),
    });
    const environment = await environmentalist({
      ...options(cwd, schema),
      argv: ['--mode=production'],
      exclude: ['env', 'project-config', 'user-dotfile', 'xdg-config', 'home-config'],
    });
    expect(environment).toMatchObject({
      base: 'base',
      expanded: 'base-expanded',
      package: 'package',
    });
    const safe = await environmentalist.safe({
      ...options(cwd, schema),
      exclude: ['env', 'defaults'],
    });
    expect(safe.success).toBe(false);
  });

  it('coerces strings, honors coerce false, and bypasses coercion for typed sources', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({ count: z.number(), enabled: z.boolean() });
    const coerced = await environmentalist(
      options(cwd, schema, { env: { COUNT: '3', ENABLED: 'yes' } }),
    );
    expect(typeof coerced.count).toBe('number');
    expect(typeof coerced.enabled).toBe('boolean');
    const uncoerced = await environmentalist.safe(
      options(cwd, schema, { env: { COUNT: '3', ENABLED: 'yes' }, coerce: false }),
    );
    expect(uncoerced.success).toBe(false);
    const typed = await environmentalist.safe({
      ...options(cwd, schema),
      sources: [
        {
          id: 'typed-test',
          kind: 'typed',
          load: () => ({ values: { count: 3, enabled: true }, location: 'typed' }),
        },
      ],
    });
    expect(typed.success).toBe(true);
    if (typed.success) {
      expect(typed.data.count).toBe(3);
      expect(typed.data.enabled).toBe(true);
    }
  });

  it('aggregates invalid keys, provides metadata, and masks secret values', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({
      API_KEY: secret(
        z.number().meta({ description: 'API credential', docs: 'https://docs.test/api' }),
      ),
      PORT: z.number().meta({ description: 'Listening port', docs: 'https://docs.test/port' }),
    });
    const result = await environmentalist.safe(
      options(cwd, schema, { env: { API_KEY: 'not-number', PORT: 'also-bad' } }),
    );
    try {
      await environmentalist(
        options(cwd, schema, { env: { API_KEY: 'not-number', PORT: 'also-bad' } }),
      );
      throw new Error('expected environmentalist to reject');
    } catch (error) {
      expect(error).toHaveProperty('message', expect.stringMatching(/apiKey.*port|port.*apiKey/u));
    }
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(EnvironmentalistError);
    expect(result.error.message).toContain('apiKey');
    expect(result.error.message).toContain('port');
    expect(result.error.message).toContain('API credential');
    expect(result.error.message).toContain('https://docs.test/api');
    expect(result.error.message).toContain('Fix:');
    expect(result.error.message).toContain('[redacted]');
    expect(result.error.message).toContain('also-bad');
  });

  it('supports exact env metadata overrides, sync APIs, and onResolve', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({
      DATABASE_URL: z.string().meta({ env: 'DATABASE_URL' }),
      PORT: z.number().default(3000),
    });
    const traces: unknown[] = [];
    const input = options(cwd, schema, {
      envPrefix: 'APP',
      env: { DATABASE_URL: 'database', APP_DATABASE_URL: 'ignored' },
      onResolve: (trace: unknown) => traces.push(trace),
    });
    const environment = await environmentalist(input);
    const sync = environmentalist.sync(input);
    const safeSync = environmentalist.safeSync(input);
    expect(environment.databaseUrl).toBe('database');
    expect(sync.databaseUrl).toBe('database');
    expect(safeSync.success).toBe(true);
    expect(traces).toHaveLength(3);
  });

  it('lets an exact env override replace the derived name rather than add to it', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({
      file: z.string().default('D').meta({ env: 'BATTLESTATION_CONFIGURATION' }),
      nested: z.object({ value: z.string().meta({ env: 'EXACT_NESTED' }) }).default({ value: 'N' }),
    });
    const resolve = (env: Record<string, string>) =>
      environmentalist(options(cwd, schema, { env }));

    const derived = await resolve({ FILE: 'derived' });
    const forced = await resolve({ BATTLESTATION_CONFIGURATION: 'forced' });
    const both = await resolve({ FILE: 'derived', BATTLESTATION_CONFIGURATION: 'forced' });

    expect(derived.file).toBe('D');
    expect(forced.file).toBe('forced');
    expect(both.file).toBe('forced');

    const derivedNested = await resolve({ NESTED__VALUE: 'derived' });
    const forcedNested = await resolve({ EXACT_NESTED: 'forced' });

    expect(derivedNested.nested.value).toBe('N');
    expect(forcedNested.nested.value).toBe('forced');
  });

  it('normalizes thrown errors across async, sync, and safe APIs', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({ VALUE: z.string() });
    const source = {
      id: 'broken',
      kind: 'typed' as const,
      load: () => {
        throw 'broken source';
      },
      loadSync: () => {
        throw new Error('sync source');
      },
    };
    const asyncSafe = await environmentalist.safe({ ...options(cwd, schema), sources: [source] });
    expect(asyncSafe.success).toBe(false);
    if (!asyncSafe.success) expect(asyncSafe.error.message).toBe('broken source');
    expect(() => environmentalist.sync({ ...options(cwd, schema), sources: [source] })).toThrow(
      'sync source',
    );
    const syncSafe = environmentalist.safeSync({ ...options(cwd, schema), sources: [source] });
    expect(syncSafe.success).toBe(false);
    try {
      await environmentalist({ ...options(cwd, schema), sources: [source] });
    } catch (error) {
      expect(error).toHaveProperty('message', expect.stringContaining('broken source'));
    }
  });

  it('creates a Node watcher through the public resolver', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({ VALUE: z.string() });
    const watcher = environmentalist.watch({
      ...options(cwd, schema, { env: { VALUE: 'watching' } }),
      exclude: [
        'dotenv',
        'project-config',
        'package-json',
        'user-dotfile',
        'xdg-config',
        'home-config',
      ],
      scheduleIdle: () => () => undefined,
      watchFile: () => () => undefined,
    });
    await watcher.ready;
    expect(watcher.current.value).toBe('watching');
    await watcher.close();
  });

  it('rejects aliases that are not schema keys at compile time and catches schema guards safely', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({ API_KEY: z.string() });
    const invalidOptions: EnvironmentalistOptions<typeof schema> = {
      ...options(cwd, schema),
      // @ts-expect-error aliases must point at canonical schema keys
      aliases: { k: 'missing' },
    };
    void invalidOptions;
    const result = await environmentalist.safe({
      ...options(cwd, z.object({ API_KEY: z.string(), apiKey: z.string() })),
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(EnvironmentalistError);
  });
});
