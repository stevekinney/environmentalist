/* eslint-disable typescript/no-unsafe-type-assertion */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { EnvironmentalistError } from './errors.js';
import { guardSchema, resolveMode, resolveRaw, resolveRawSync } from './resolve.js';
import { schemaDefaults, schemaShape } from './resolve-core.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'environmentalist-resolve-'));
  directories.push(directory);
  return directory;
}

function options(cwd: string, schema: z.ZodObject, overrides: Record<string, unknown> = {}) {
  return { name: 'app', schema, cwd, root: cwd, env: {}, argv: [], ...overrides } as const;
}

describe('resolveRaw', () => {
  it('resolves precedence across flags, env, dotenv, project, package, and home sources', async () => {
    const cwd = await temporaryDirectory();
    const home = await temporaryDirectory();
    const xdg = join(home, 'xdg');
    await mkdir(join(xdg, 'app'), { recursive: true });
    await mkdir(join(home, '.environmentalist'), { recursive: true });
    await writeFile(join(cwd, '.env'), 'VALUE=dotenv\n');
    await writeFile(join(cwd, 'app.config.json'), '{"value":"project"}');
    await writeFile(join(cwd, 'package.json'), '{"app":{"value":"package"}}');
    await writeFile(join(home, '.app'), 'VALUE=dotfile\n');
    await writeFile(join(xdg, 'app', 'config.json'), '{"value":"xdg"}');
    await writeFile(join(home, '.environmentalist', 'app'), '{"value":"home"}');

    const schema = z.object({ value: z.string().default('default') });
    const raw = await resolveRaw(
      options(cwd, schema, {
        home,
        env: { VALUE: 'env', XDG_CONFIG_HOME: xdg },
        argv: ['--value', 'flag'],
      }),
    );

    expect(raw.values['value']).toBe('flag');
    expect(raw.provenance['value']?.source).toBe('flags');
    expect(raw.checked['value']).toEqual([
      'flag --value',
      'search ?value',
      'env VALUE',
      '.env',
      `app.config.* (up from ${cwd})`,
      'package.json',
      '~/.app',
      '~/.config/app/config.*',
      '~/.environmentalist/app',
      'schema defaults',
    ]);
  });

  it('composes nested values by leaf and maps double-underscore env names', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({ server: z.object({ port: z.number(), host: z.string() }) });
    const raw = await resolveRaw(
      options(cwd, schema, {
        env: { SERVER__HOST: 'example.test' },
        argv: ['--server.port', '3000'],
      }),
    );
    expect(raw.values).toEqual({ server: { port: 3000, host: 'example.test' } });
    expect(raw.provenance['server.port']?.source).toBe('flags');
    expect(raw.provenance['server.host']?.source).toBe('env');
  });

  it('uses a flag-selected mode before loading the mode dotenv file', async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, '.env.development'), 'VALUE=development\n');
    await writeFile(join(cwd, '.env.production'), 'VALUE=production\n');
    const schema = z.object({ mode: z.string().default('development'), value: z.string() });
    const raw = await resolveRaw(options(cwd, schema, { argv: ['--mode', 'production'] }));
    expect(raw.values).toEqual({ mode: 'production', value: 'production' });
    expect(resolveMode(options(cwd, schema, { argv: ['--mode', 'production'] }))).toBe(
      'production',
    );
  });

  it('honors source exclusions and reports excluded defaults', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({ fromEnv: z.string(), defaulted: z.string().default('nope') });
    const raw = await resolveRaw(
      options(cwd, schema, { env: { FROM_ENV: 'present' }, exclude: ['env'] }),
    );
    expect(raw.values).toEqual({ defaulted: 'nope' });
    expect(raw.checked['fromEnv']).not.toContain('env FROM_ENV');

    const withoutDefaults = await resolveRaw(
      options(cwd, z.object({ value: z.string().default('nope') }), { exclude: ['defaults'] }),
    );
    expect(withoutDefaults.values).toEqual({});
    expect(withoutDefaults.defaultsExcluded).toBe(true);
  });

  it('supports coercion controls and typed-source bypass', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({ count: z.number(), enabled: z.boolean() });
    const coerced = await resolveRaw(options(cwd, schema, { env: { COUNT: '3', ENABLED: 'yes' } }));
    expect(coerced.values).toEqual({ count: 3, enabled: true });

    const uncoerced = await resolveRaw(
      options(cwd, schema, { env: { COUNT: '3', ENABLED: 'yes' }, coerce: false }),
    );
    expect(uncoerced.values).toEqual({ count: '3', enabled: 'yes' });

    const typed = await resolveRaw({
      name: 'app',
      schema,
      cwd,
      sources: [
        {
          id: 'typed-test',
          kind: 'typed',
          load: () => ({ values: { count: '3', enabled: 'yes' }, location: 'typed' }),
        },
      ],
    });
    expect(typed.values).toEqual({ count: '3', enabled: 'yes' });
  });

  it('uses exact env overrides with a prefix and supports the sync path', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({ apiKey: z.string() });
    const raw = await resolveRaw(
      options(cwd, schema, {
        envPrefix: 'APP',
        env: { EXACT_KEY: 'forced', APP_API_KEY: 'ignored' },
      }),
      { envOverrides: { apiKey: 'EXACT_KEY' } },
    );
    expect(raw.values).toEqual({ apiKey: 'forced' });
    expect(raw.checked['apiKey']).toContain('env EXACT_KEY');
    const forcedFlag = await resolveRaw(
      options(cwd, schema, { env: {}, argv: ['--custom-key', 'from-flag'] }),
      { flagOverrides: { apiKey: 'custom-key' } },
    );
    expect(forcedFlag.values).toEqual({ apiKey: 'from-flag' });
    expect(resolveRawSync(options(cwd, schema, { env: { API_KEY: 'sync' } })).values).toEqual({
      apiKey: 'sync',
    });
    const unknownOverride = await resolveRaw(
      options(cwd, schema, { argv: ['--other-name', 'value'] }),
      { flagOverrides: { unknown: 'other-name' } },
    );
    expect(unknownOverride.values).toEqual({ otherName: 'value' });
  });
});

describe('schema guards', () => {
  it('names both keys in a canonical collision', () => {
    expect(() => guardSchema(z.object({ FOO_BAR: z.string(), fooBar: z.string() }), 'app')).toThrow(
      /FOO_BAR.*fooBar|fooBar.*FOO_BAR/u,
    );
  });

  it('rejects passthrough and catchall objects', () => {
    expect(() =>
      guardSchema(z.object({ nested: z.object({ value: z.string() }).passthrough() }), 'app'),
    ).toThrow(/passthrough\/catchall/u);
    expect(() => guardSchema(z.object({}).catchall(z.string()), 'app')).toThrow(
      /passthrough\/catchall/u,
    );
  });

  it('throws the EnvironmentalistError type for invalid schemas', () => {
    try {
      guardSchema(z.object({ FOO: z.string(), foo: z.string() }), 'app');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentalistError);
    }
  });

  it('rethrows unexpected guard failures unchanged', () => {
    const schema = {
      _zod: {
        get def(): never {
          throw new Error('unexpected schema failure');
        },
      },
    };
    expect(() => guardSchema(schema as never, 'app')).toThrow('unexpected schema failure');
  });

  it('reads fallback schema definitions and stops cyclic wrapper traversal', () => {
    expect(schemaShape({ def: { type: 'object', shape: {} } })).toEqual({});
    expect(schemaShape({ _def: { type: 'object', shape: {} } })).toEqual({});
    expect(schemaShape({})).toBeUndefined();
    expect(schemaDefaults(z.object({ value: z.string() }))).toEqual({});
    const cyclic: { def: { type: string; innerType?: unknown } } = { def: { type: 'optional' } };
    cyclic.def.innerType = cyclic;
    expect(schemaShape(cyclic)).toBeUndefined();
    const cyclicObject = z.object({ value: cyclic as never });
    expect(schemaDefaults(cyclicObject)).toEqual({});
  });
});
