import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createEnvironmentRecordSource } from './environment-record.js';
import { environmentalist } from './environmentalist.js';
import type { SourceContext } from './types.js';

const context: SourceContext = {
  name: 'app',
  cwd: '.',
  mode: undefined,
  env: {},
  argv: [],
  envPrefix: undefined,
};

function load(source: ReturnType<typeof createEnvironmentRecordSource>) {
  return source.loadSync?.(context);
}

describe('createEnvironmentRecordSource', () => {
  const schema = z.object({
    apiKey: z.string().meta({ env: 'SERVICE_TOKEN' }),
    serverPort: z.number().optional(),
  });

  it('uses forced metadata names and derived spellings for top-level fields', () => {
    expect(
      load(
        createEnvironmentRecordSource({
          schema,
          environment: { SERVICE_TOKEN: 'token', SERVER_PORT: '3000', API_KEY: 'ignored' },
        }),
      ),
    ).toEqual({
      values: { apiKey: 'token', serverPort: '3000' },
      location: 'environment record',
    });
  });

  it('does not add a key when its environment variable is missing', () => {
    expect(
      load(
        createEnvironmentRecordSource({
          schema,
          environment: { SERVICE_TOKEN: 'token', SERVER_PORT: 3000 },
        }),
      ),
    ).toEqual({ values: { apiKey: 'token' }, location: 'environment record' });
  });

  it('resolves a caller record through the synchronous resolver', () => {
    const source = createEnvironmentRecordSource({
      schema,
      environment: { SERVICE_TOKEN: 'token', SERVER_PORT: '3000' },
    });
    expect(
      environmentalist.sync({
        name: 'app',
        schema,
        cwd: '.',
        env: {},
        argv: [],
        sources: [source],
      }),
    ).toMatchObject({ apiKey: 'token', serverPort: 3000 });
  });

  it('returns no values for an empty caller record', () => {
    expect(load(createEnvironmentRecordSource({ schema, environment: {} }))).toBeUndefined();
  });

  it('returns no values without a caller record or process global', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
    expect(descriptor?.configurable).toBe(true);
    Reflect.deleteProperty(globalThis, 'process');
    try {
      expect(load(createEnvironmentRecordSource({ schema }))).toBeUndefined();
    } finally {
      if (descriptor !== undefined) Object.defineProperty(globalThis, 'process', descriptor);
    }
  });

  it('falls back to process.env when a caller record is omitted', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      value: { env: { SERVICE_TOKEN: 'fallback' } },
    });
    try {
      expect(load(createEnvironmentRecordSource({ schema }))).toEqual({
        values: { apiKey: 'fallback' },
        location: 'environment record',
      });
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'process');
      else Object.defineProperty(globalThis, 'process', descriptor);
    }
  });
});
