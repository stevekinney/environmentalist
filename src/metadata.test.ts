/* eslint-disable typescript/no-unsafe-type-assertion */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  envOverridesOf,
  flagOverridesOf,
  metadataFor,
  registry,
  secret,
  secretKeysOf,
} from './metadata.js';

describe('metadata', () => {
  it('merges global metadata with typed metadata, preferring typed values', () => {
    const field = z
      .string()
      .meta({ description: 'global description', docs: 'https://docs.example.test' })
      .register(registry, { description: 'typed description', secret: true });

    expect(metadataFor(field)).toEqual({
      description: 'typed description',
      docs: 'https://docs.example.test',
      secret: true,
    });
  });

  it('finds metadata through optional, nullable, and default wrappers', () => {
    const field = z
      .string()
      .meta({ description: 'wrapped' })
      .optional()
      .nullable()
      .default('value');
    expect(metadataFor(field).description).toBe('wrapped');
  });

  it('registers secrets without changing the schema identity', () => {
    const field = z.string();
    expect(secret(field)).toBe(field);
    expect(metadataFor(field).secret).toBe(true);
  });

  it('finds top-level and nested secret paths', () => {
    const schema = z.object({
      API_KEY: secret(z.string()),
      nested: z.object({ TOKEN: secret(z.string()), visible: z.string() }),
    });
    expect(secretKeysOf(schema)).toEqual(new Set(['apiKey', 'nested.token']));
  });

  it('returns canonical source overrides', () => {
    const schema = z.object({
      DATABASE_URL: z.string().meta({ env: 'DATABASE_URL' }),
      nested: z.object({ API_TOKEN: z.string().meta({ flag: 'token' }) }),
    });
    expect(envOverridesOf(schema)).toEqual({ databaseUrl: 'DATABASE_URL' });
    expect(flagOverridesOf(schema)).toEqual({ 'nested.apiToken': 'token' });
  });

  it('handles definition fallbacks and cyclic wrapper guards', () => {
    expect(secretKeysOf({ _zod: { parent: null } } as never)).toEqual(new Set());
    expect(
      secretKeysOf({ _zod: { parent: null }, def: { type: 'object', shape: null } } as never),
    ).toEqual(new Set());
    expect(
      metadataFor({ _zod: { parent: null }, def: { type: 'string' } } as unknown as z.ZodType),
    ).toEqual({});
    expect(
      metadataFor({ _zod: { parent: null }, _def: { type: 'string' } } as unknown as z.ZodType),
    ).toEqual({});
    const cyclic: { _zod: { parent: null }; def: { type: string; innerType?: unknown } } = {
      _zod: { parent: null },
      def: { type: 'optional' },
    };
    cyclic.def.innerType = cyclic;
    expect(metadataFor(cyclic as unknown as z.ZodType)).toEqual({});
    expect(secretKeysOf(cyclic as unknown as z.ZodObject)).toEqual(new Set());
  });
});
