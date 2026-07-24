/* eslint-disable typescript/no-unsafe-type-assertion */

import { inspect } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { z } from 'zod';

import { EnvironmentalistError, environmentalist, registry, toJSONSchema } from './index.js';
import { secret } from './metadata.js';
import { defineConfig } from './tooling/define-config.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'environmentalist-tooling-'));
  directories.push(directory);
  return directory;
}

describe('tooling helpers', () => {
  it('returns the configuration object passed to defineConfig', () => {
    const configuration = { port: 3000 };
    expect(defineConfig(configuration)).toBe(configuration);
  });

  it('emits native JSON Schema with typed registry metadata and passes meta-schema validation', () => {
    const port = z.number();
    registry.add(port, { description: 'Port', example: 3000 });
    const schema = z.object({
      PORT: port,
      API_KEY: secret(z.string().meta({ description: 'Key' })),
    });
    const jsonSchema = toJSONSchema(schema);
    const validator = new Ajv2020();
    expect(validator.validateSchema(jsonSchema)).toBe(true);
    const properties = jsonSchema['properties'];
    expect(properties).toBeDefined();
    if (properties === null || typeof properties !== 'object') return;
    const portProperty = Object.getOwnPropertyDescriptor(properties, 'PORT')?.value;
    const apiKey = Object.getOwnPropertyDescriptor(properties, 'API_KEY')?.value;
    expect(portProperty).toMatchObject({ description: 'Port', example: 3000 });
    expect(apiKey).toMatchObject({ description: 'Key' });
  });

  it('scaffolds documented TypeScript and env example files', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({
      API_KEY: secret(z.string().meta({ description: 'Secret key', example: 'do-not-write' })),
      PORT: z.number().default(3000).meta({ description: 'Server port', example: 8080 }),
      HOST_NAME: z.string().meta({ description: 'Host name' }),
      ITEMS: z.array(z.string()).meta({ example: ['item'] }),
    });
    await environmentalist.initialize({ name: 'app', schema, cwd, envExample: true });
    const config = await readFile(join(cwd, 'app.config.ts'), 'utf8');
    const envExample = await readFile(join(cwd, '.env.example'), 'utf8');
    expect(config).toContain('Secret key');
    expect(config).toContain('Server port');
    expect(config).toContain('apiKey: ""');
    expect(config).toContain('port: 3000');
    expect(config).toContain('hostName: "value"');
    expect(config).toContain('items: ["item"]');
    expect(config).toContain('// # Example: do-not-write');
    expect(config).not.toContain('apiKey: "do-not-write"');
    expect(envExample).toContain('# Secret key');
    expect(envExample).toContain('API_KEY=');
    expect(envExample).toContain('PORT=8080');
    expect(envExample).toContain('HOST_NAME=');
  });

  it('writes JSON, TOML, and YAML scaffolds without JSON comments', async () => {
    const schema = z.object({
      VALUE: z.string().meta({ description: 'A value', example: 'example' }),
      ITEMS: z.array(z.string()).meta({ example: ['item'] }),
    });
    for (const format of ['json', 'toml', 'yaml'] as const) {
      const cwd = await temporaryDirectory();
      await environmentalist.initialize({ name: 'app', schema, cwd, format });
      const contents = await readFile(join(cwd, `app.config.${format}`), 'utf8');
      if (format === 'json') {
        expect(JSON.parse(contents)).toEqual({ value: 'example', items: ['item'] });
        expect(contents).not.toContain('//');
      } else {
        expect(contents).toContain('A value');
        expect(contents).toContain('example');
      }
    }
  });

  it('scaffolds every supported placeholder type and nested environment key', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({
      TEXT: z.string(),
      COUNT: z.number(),
      BIG: z.bigint(),
      ENABLED: z.boolean(),
      DATE: z.date(),
      ITEMS: z.array(z.string()),
      PAIR: z.tuple([z.string(), z.number()]).meta({ example: ['pair', 1] }),
      NESTED: z.object({ VALUE: z.string().meta({ env: 'CUSTOM_VALUE' }) }),
      LOOKUP: z.record(z.string(), z.string()),
      CHOICE: z.enum(['one', 'two']),
      LITERAL: z.literal('literal'),
      UNION: z.union([z.number(), z.string()]),
      NULLABLE: z.string().nullable(),
      OPTIONAL: z.string().optional(),
      FALLBACK: z.string().catch('fallback'),
    });
    await environmentalist.initialize({ name: 'complex', schema, cwd, envExample: true });
    const config = await readFile(join(cwd, 'complex.config.ts'), 'utf8');
    const envExample = await readFile(join(cwd, '.env.example'), 'utf8');
    expect(config).toContain('big: 1n');
    expect(config).toContain('date: "2020-01-01T00:00:00.000Z"');
    expect(config).toContain('nested:');
    expect(envExample).toContain('CUSTOM_VALUE=');
    expect(envExample).not.toContain('NESTED=');
  });

  it('serializes circular examples, uncommon TypeScript values, and nested TOML sections', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const schema = z.object({
      CIRCULAR: secret(z.string().meta({ example: circular })),
      BIG: z.bigint().meta({ example: 3n }),
      ENABLED: z.boolean(),
      ITEMS: z.array(z.number()).meta({ example: [1, 2] }),
      OBJECT_ARRAY: z.array(z.object({ VALUE: z.string() })).meta({ example: [{ VALUE: 'x' }] }),
      NESTED: z.object({ VALUE: z.string().meta({ example: 'nested' }) }),
    });
    const cwd = await temporaryDirectory();
    await environmentalist.initialize({ name: 'toml', schema, cwd, format: 'toml' });
    const toml = await readFile(join(cwd, 'toml.config.toml'), 'utf8');
    expect(toml).toContain('big = 3');
    expect(toml).toContain('enabled = false');
    expect(toml).toContain('items = [1, 2]');
    expect(toml).toContain('[nested]');

    const tsCwd = await temporaryDirectory();
    const tsSchema = z.object({
      SYMBOL: z.string().meta({ example: Symbol('value') }),
      OBJECTS: z.array(z.object({ VALUE: z.string() })).meta({ example: [{ VALUE: 'value' }] }),
    });
    await environmentalist.initialize({ name: 'symbols', schema: tsSchema, cwd: tsCwd });
    expect(await readFile(join(tsCwd, 'symbols.config.ts'), 'utf8')).toContain('[object Symbol]');

    const yamlCwd = await temporaryDirectory();
    await environmentalist.initialize({ name: 'yaml', schema, cwd: yamlCwd, format: 'yaml' });
    expect(await readFile(join(yamlCwd, 'yaml.config.yaml'), 'utf8')).toContain('circular:');

    const jsonCwd = await temporaryDirectory();
    await environmentalist.initialize({ name: 'json', schema, cwd: jsonCwd, format: 'json' });
    expect(JSON.parse(await readFile(join(jsonCwd, 'json.config.json'), 'utf8'))).toMatchObject({
      items: [1, 2],
      nested: { value: 'nested' },
    });
  });

  it('handles schema-definition fallback fields while generating a scaffold', async () => {
    const cwd = await temporaryDirectory();
    const schema = {
      _zod: { parent: null },
      def: {
        type: 'object',
        shape: {
          UNKNOWN: { _zod: { parent: null }, def: { type: 'unknown-custom' } },
          ENUM: { _zod: { parent: null }, def: { type: 'enum' } },
          UNION: { _zod: { parent: null }, def: { type: 'union', options: [] } },
          UNDEFINED_TYPE: { _zod: { parent: null }, def: {} },
          LEGACY: { _zod: { parent: null }, _def: { type: 'string' } },
          NO_DEFINITION: { _zod: { parent: null } },
        },
      },
    } as unknown as z.ZodObject;
    await environmentalist.initialize({ name: 'fallback', schema, cwd });
    expect(await Bun.file(join(cwd, 'fallback.config.ts')).exists()).toBe(true);
  });

  it('round-trips the generated TypeScript configuration', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({ API_KEY: secret(z.string()), PORT: z.number(), HOST: z.string() });
    await environmentalist.initialize({ name: 'app', schema, cwd });
    const environment = await environmentalist({
      name: 'app',
      schema,
      cwd,
      env: {},
      argv: [],
      exclude: [
        'env',
        'dotenv',
        'package-json',
        'user-dotfile',
        'xdg-config',
        'home-config',
        'defaults',
      ],
    });
    expect(environment).toMatchObject({ apiKey: '', port: 1, host: 'value' });
  });

  it('keeps secret values accessible while masking inspect output', async () => {
    const cwd = await temporaryDirectory();
    const schema = z.object({ API_KEY: secret(z.string()) });
    const environment = await environmentalist({
      name: 'app',
      schema,
      cwd,
      env: { API_KEY: 'real' },
      argv: [],
    });
    expect(environment.apiKey).toBe('real');
    expect(inspect(environment)).not.toContain('real');
  });

  it('exposes EnvironmentalistError as a stable public class', () => {
    expect(new EnvironmentalistError('message')).toBeInstanceOf(Error);
  });
});
