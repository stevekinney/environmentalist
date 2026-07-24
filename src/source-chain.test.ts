/* eslint-disable typescript/no-unsafe-type-assertion */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { SourceContext } from './types.js';
import {
  DEFAULT_SOURCE_NAMES,
  createDefaultsSource,
  createSourceChain,
  schemaDefaults,
} from './source-chain.js';

function context(): SourceContext {
  return {
    name: 'app',
    cwd: '.',
    mode: undefined,
    env: {},
    argv: [],
    envPrefix: undefined,
  };
}

describe('source-chain', () => {
  it('assembles the documented default order and filters built-ins', () => {
    const schema = z.object({ port: z.number().default(3000) });
    const sources = createSourceChain(schema, { name: 'app', schema, exclude: ['env'] });
    expect(sources.map((source) => source.id)).toEqual(
      DEFAULT_SOURCE_NAMES.filter((name) => name !== 'env'),
    );
  });

  it('uses custom sources as the wholesale chain', () => {
    const schema = z.object({ value: z.string() });
    const custom = {
      id: 'custom',
      kind: 'typed' as const,
      load: () => ({ values: { value: 'custom' }, location: 'test' }),
    };
    expect(createSourceChain(schema, { name: 'app', schema, sources: [custom] })).toEqual([custom]);
    expect(
      createSourceChain(schema, { name: 'app', schema, sources: ['unknown' as never] }),
    ).toEqual([]);
  });

  it('maps schema-known and unknown flag overrides', () => {
    const schema = z.object({ server: z.object({ PORT: z.number() }) });
    const sources = createSourceChain(
      schema,
      { name: 'app', schema, argv: ['--custom-port', '3000'] },
      {
        flagOverrides: { 'server.port': 'custom-port', unknown: 'other-name' },
      },
    );
    expect(
      sources[0]?.loadSync?.({
        name: 'app',
        cwd: '.',
        mode: undefined,
        env: {},
        argv: ['--custom-port', '3000'],
        envPrefix: undefined,
      })?.values,
    ).toEqual({ server: { port: '3000' } });
  });

  it('extracts top-level defaults through supported wrappers', async () => {
    const schema = z.object({
      direct: z.string().default('direct'),
      wrapped: z.string().optional().nullable().catch('ignored').default('wrapped'),
      missing: z.string().optional(),
    });
    expect(schemaDefaults(schema)).toEqual({ direct: 'direct', wrapped: 'wrapped' });
    expect(await createDefaultsSource(schema).load(context())).toEqual({
      values: { direct: 'direct', wrapped: 'wrapped' },
      location: 'schema defaults',
    });
  });
});
