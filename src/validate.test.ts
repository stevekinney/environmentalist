/* eslint-disable typescript/no-unsafe-type-assertion */

import { inspect } from 'node:util';

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { EnvironmentalistError } from './errors.js';
import { secret } from './metadata.js';
import { MASKED } from './redact.js';
import { safeValidateResolved, toPublic, traceResolution, validateResolved } from './validate.js';
import { SCHEMA, SOURCES } from './types.js';
import type { Environment } from './types.js';
import type { ResolvedRaw } from './validate.js';

function resolved(
  values: Record<string, unknown>,
  overrides: Partial<ResolvedRaw> = {},
): ResolvedRaw {
  return {
    values,
    provenance: {},
    trace: {},
    checked: {},
    defaultsExcluded: false,
    ...overrides,
  };
}

describe('validateResolved', () => {
  it('remaps original schema spellings, freezes output, and redacts serialization', () => {
    const schema = z.object({
      ANTHROPIC_API_KEY: secret(z.string()),
      PORT: z.number(),
      nested: z.object({ API_TOKEN: secret(z.string()), VALUE: z.string() }),
    });
    const environment = validateResolved({
      name: 'app',
      schema,
      resolved: resolved(
        {
          anthropicApiKey: 'real-secret',
          port: 3000,
          nested: { apiToken: 'nested-secret', value: 'ok' },
        },
        {
          provenance: {
            anthropicApiKey: { source: 'env', location: 'ANTHROPIC_API_KEY' },
            port: { source: 'env', location: 'PORT' },
          },
        },
      ),
    });

    expect(environment.anthropicApiKey).toBe('real-secret');
    expect((environment as Record<string, unknown>)['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(Object.isFrozen(environment)).toBe(true);
    expect(Object.isFrozen(environment.nested)).toBe(true);
    expect(Object.isFrozen(environment[SOURCES])).toBe(true);
    expect(Object.isFrozen(environment[SOURCES].port)).toBe(true);
    expect(environment[SOURCES].port).toEqual({ source: 'env', location: 'PORT' });
    expect(environment[SCHEMA]).toBe(schema);

    const json = JSON.stringify(environment);
    expect(json).toContain(MASKED);
    expect(json).not.toContain('real-secret');
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const customInspect = (environment as unknown as Record<symbol, () => unknown>)[
      Symbol.for('nodejs.util.inspect.custom')
    ]!();
    expect(customInspect).toEqual({
      anthropicApiKey: MASKED,
      port: 3000,
      nested: { apiToken: MASKED, value: 'ok' },
    });
    expect(inspect(environment)).toContain(MASKED);
    expect(inspect(environment)).not.toContain('real-secret');
  });

  it('leaves the caller-owned schema unfrozen and its lazy methods callable', () => {
    const schema = z.object({
      configuration: z.string().meta({ description: 'y' }),
      nested: z.object({ value: z.string() }),
    });
    const environment = validateResolved({
      name: 'app',
      schema,
      resolved: resolved({ configuration: 'x', nested: { value: 'ok' } }),
    });

    expect(Object.isFrozen(environment)).toBe(true);
    expect(Object.isFrozen(schema)).toBe(false);
    expect(Object.isFrozen(schema.shape.configuration)).toBe(false);
    expect(Object.isFrozen(schema.shape.nested.shape.value)).toBe(false);
    // Zod materializes instance methods through lazy getters that define
    // properties on first access, so a frozen schema breaks them afterwards.
    expect(schema.shape.configuration.meta()).toMatchObject({ description: 'y' });
    expect(schema.shape.configuration.optional().safeParse(undefined).success).toBe(true);
  });

  it('aggregates invalid fields into one actionable error and masks secret values', () => {
    const schema = z.object({
      API_KEY: secret(
        z.string().meta({ description: 'API credential', docs: 'https://docs.test/api' }),
      ),
      PORT: z.number().meta({ description: 'Listening port', docs: 'https://docs.test/port' }),
    });
    const result = safeValidateResolved({
      name: 'app',
      schema,
      resolved: resolved(
        { apiKey: 123, port: 'not-a-number' },
        {
          provenance: {
            apiKey: { source: 'env', location: 'API_KEY' },
            port: { source: 'env', location: 'PORT' },
          },
          checked: {
            apiKey: ['env API_KEY', 'flag --api-key'],
            port: ['env PORT', 'flag --port'],
          },
        },
      ),
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(EnvironmentalistError);
    expect(result.error.issues).toHaveLength(2);
    expect(result.error.message).toContain('apiKey');
    expect(result.error.message).toContain('port');
    expect(result.error.message).toContain('API credential');
    expect(result.error.message).toContain('https://docs.test/api');
    expect(result.error.message).toContain('Checked:');
    expect(result.error.message).toContain('Fix:');
    expect(result.error.message).toContain('not-a-number');
    expect(result.error.message).not.toContain('123');
    expect(result.error.message).toContain(MASKED);
  });

  it('makes defaulted fields required when defaults are excluded', () => {
    const schema = z.object({ VALUE: z.string().default('fallback') });
    const result = safeValidateResolved({
      name: 'app',
      schema,
      resolved: resolved({}, { defaultsExcluded: true, checked: { value: ['schema defaults'] } }),
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('value — required, but not found');
  });

  it('returns a frozen public object without secrets or symbols', () => {
    const schema = z.object({ API_KEY: secret(z.string()), PORT: z.number() });
    const environment = validateResolved({
      name: 'app',
      schema,
      resolved: resolved({ apiKey: 'secret', port: 3000 }),
    });
    const publicEnvironment = toPublic(environment);

    expect(publicEnvironment).toEqual({ port: 3000 });
    expect(Object.isFrozen(publicEnvironment)).toBe(true);
    expect(Reflect.ownKeys(publicEnvironment)).toEqual(['port']);
    expect(structuredClone(publicEnvironment)).toEqual({ port: 3000 });
  });

  it('maps record keys, removes defaults while preserving wrappers, and omits nested secrets', () => {
    const schema = z.object({
      settings: z.record(z.string(), z.string()),
      optionalValue: z.string().default('default').optional(),
      nullableValue: z.string().default('default').nullable(),
      caughtValue: z.string().default('default').catch('caught'),
      nested: z.object({ API_KEY: secret(z.string()), values: z.array(z.string()) }),
    });
    const environment = validateResolved({
      name: 'app',
      schema,
      resolved: resolved(
        {
          settings: { FOO_BAR: 'value' },
          optionalValue: 'optional',
          nullableValue: null,
          caughtValue: 'caught',
          nested: { apiKey: 'secret', values: ['one', 'two'] },
        },
        { defaultsExcluded: true },
      ),
    });
    expect(environment.settings).toEqual({ fooBar: 'value' });
    const publicEnvironment = toPublic(environment);
    expect(publicEnvironment as unknown).toEqual({
      settings: { fooBar: 'value' },
      optionalValue: 'optional',
      nullableValue: null,
      caughtValue: 'caught',
      nested: { values: ['one', 'two'] },
    });
  });

  it('formats root and custom validation errors and traces without an injected writer', () => {
    const schema = z.object({ VALUE: z.string().refine(() => false, { message: 'not valid' }) });
    const result = safeValidateResolved({
      name: 'app',
      schema,
      resolved: resolved({ value: 'bad' }),
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('not valid');

    const originalDebug = process.env['DEBUG'];
    const originalError = globalThis.console.error;
    const output: string[] = [];
    process.env['DEBUG'] = 'environmentalist';
    globalThis.console.error = (message: unknown) => output.push(String(message));
    try {
      traceResolution({
        name: 'app',
        secretKeys: new Set(),
        trace: { value: { winning: undefined, considered: [] } },
      });
    } finally {
      globalThis.console.error = originalError;
      if (originalDebug === undefined) delete process.env['DEBUG'];
      else process.env['DEBUG'] = originalDebug;
    }
    expect(output[0]).toContain('none');
  });

  it('writes a secret-safe resolution table through an injected writer', () => {
    const output: string[] = [];
    traceResolution({
      name: 'app',
      secretKeys: new Set(['apiKey']),
      trace: {
        apiKey: {
          winning: { source: 'env', location: 'API_KEY' },
          considered: [{ source: 'env', location: 'API_KEY' }],
        },
      },
      writer: (message) => output.push(message),
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toContain('apiKey');
    expect(output[0]).toContain('env API_KEY');
    expect(output[0]).not.toContain('secret');
  });

  it('supports legacy schema definitions and masks circular invalid values', () => {
    const field = { _zod: { parent: null }, def: { type: 'string' } };
    const cyclic: { _zod: { parent: null }; def: { type: string; innerType?: unknown } } = {
      _zod: { parent: null },
      def: { type: 'optional' },
    };
    cyclic.def.innerType = cyclic;
    const schema = {
      _zod: { parent: null },
      def: { type: 'object', shape: { VALUE: field } },
    } as unknown as z.ZodObject;
    const publicEnvironment = { value: 'ok' } as unknown as Environment<typeof schema>;
    Object.defineProperty(publicEnvironment, SCHEMA, { value: schema });
    expect(toPublic(publicEnvironment)).toEqual({ value: 'ok' });

    for (const legacySchema of [
      { def: { type: 'object', shape: { VALUE: field } } },
      { _def: { type: 'object', shape: { VALUE: field } } },
    ]) {
      const legacyEnvironment = { value: 'ok' } as unknown as Environment<typeof schema>;
      Object.defineProperty(legacyEnvironment, SCHEMA, { value: legacySchema });
      expect(toPublic(legacyEnvironment)).toEqual({ value: 'ok' });
    }

    for (const legacySchema of [
      {
        def: {
          type: 'object',
          shape: {
            VALUE: field,
            OPTIONAL: z.string().optional(),
            NO_DEF: { _zod: { parent: null } },
            CYCLIC: cyclic,
          },
        },
      },
      {
        _def: {
          type: 'object',
          shape: {
            VALUE: field,
            OPTIONAL: z.string().optional(),
            NO_DEF: { _zod: { parent: null } },
            CYCLIC: cyclic,
          },
        },
      },
      { _zod: { parent: null }, def: { type: 'object', shape: null } },
    ]) {
      const runtimeSchema = {
        ...legacySchema,
        safeParse: () => ({ success: false, error: { issues: [] } }),
      } as unknown as z.ZodObject;
      const result = safeValidateResolved({
        name: 'app',
        schema: runtimeSchema,
        resolved: resolved({ value: 'ok', optional: {}, noDef: {}, cyclic: {} }),
      });
      expect(result.success).toBe(false);
    }

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const result = safeValidateResolved({
      name: 'app',
      schema: z.object({ VALUE: z.number() }),
      resolved: resolved({ value: circular }),
    });
    expect(result.success).toBe(false);
  });
});
