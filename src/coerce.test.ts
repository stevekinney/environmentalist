import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  applyEnvironmentOverrides,
  coerceValue,
  flattenSourceValue,
  hasAncestorWinner,
  hasDescendantWinner,
  loadSources,
  loadSourcesSync,
  pathsRelate,
  setValueAtPath,
  valueAtPath,
} from './coerce.js';
import type { Source } from './types.js';

describe('coerceValue', () => {
  it('unwraps modifiers and parses numeric values', () => {
    expect(coerceValue('42', z.number().optional().default(1))).toBe(42);
    expect(coerceValue('42', z.bigint().catch(0n))).toBe(42n);
    expect(coerceValue('not-a-number', z.number())).toBe('not-a-number');
  });

  it('parses recognized booleans while preserving unknown strings', () => {
    expect(coerceValue('YeS', z.boolean())).toBe(true);
    expect(coerceValue('OFF', z.boolean())).toBe(false);
    expect(coerceValue('sometimes', z.boolean())).toBe('sometimes');
  });

  it('parses dates, JSON objects, and JSON arrays', () => {
    expect(coerceValue('2025-01-01', z.date())).toBeInstanceOf(Date);
    expect(coerceValue('{"enabled":true}', z.object({ enabled: z.boolean() }))).toEqual({
      enabled: true,
    });
    expect(coerceValue('["1","2"]', z.array(z.number()))).toEqual([1, 2]);
    expect(coerceValue('plain text', z.array(z.string()))).toBe('plain text');
  });

  it('coerces repeated string values against an array element schema', () => {
    expect(coerceValue(['1', '2'], z.array(z.number()))).toEqual([1, 2]);
  });

  it('handles invalid scalar and JSON inputs and non-string values', () => {
    expect(coerceValue('not-bigint', z.bigint())).toBe('not-bigint');
    expect(coerceValue('not-a-date', z.date())).toBe('not-a-date');
    expect(coerceValue('{invalid}', z.object({ value: z.string() }))).toBe('{invalid}');
    expect(coerceValue('[invalid]', z.array(z.string()))).toBe('[invalid]');
    expect(coerceValue([1, '2'], z.array(z.number()))).toEqual([1, 2]);
    expect(coerceValue(3, z.array(z.number()))).toBe(3);
    expect(coerceValue(3, z.object({ value: z.number() }))).toBe(3);
    expect(coerceValue('3', { def: { type: 'number' } })).toBe(3);
    expect(coerceValue('true', { _def: { type: 'boolean' } })).toBe(true);
    expect(coerceValue('value', {})).toBe('value');
    const cyclic: { def: { type: string; innerType?: unknown } } = { def: { type: 'optional' } };
    cyclic.def.innerType = cyclic;
    expect(coerceValue('value', cyclic)).toBe('value');
  });

  it('flattens values, sets nested paths, and compares related winners', () => {
    const candidates: Array<{ path: string; value: unknown }> = [];
    flattenSourceValue(
      { EMPTY: {}, DATE: new Date('2026-01-01'), NESTED: { VALUE: 1 } },
      '',
      candidates,
    );
    expect(candidates).toEqual([
      { path: 'empty', value: {} },
      { path: 'date', value: expect.any(Date) },
      { path: 'nested.value', value: 1 },
    ]);
    const target: Record<string, unknown> = { server: 'replace' };
    setValueAtPath(target, 'server.port', 3000);
    setValueAtPath(target, 'server.host', 'test');
    expect(target).toEqual({ server: { port: 3000, host: 'test' } });
    expect(valueAtPath(target, 'server.port')).toBe(3000);
    expect(valueAtPath(target, 'missing')).toBeUndefined();
    expect(pathsRelate('server', 'server.port')).toBe(true);
    expect(pathsRelate('port', 'server.port')).toBe(false);
    const winners = new Map([['server.port', { source: 'env', location: 'PORT' }]]);
    expect(hasAncestorWinner('server.port.value', winners)).toBe(true);
    expect(hasDescendantWinner('server', winners)).toBe(true);
  });

  it('loads asynchronous and synchronous sources and applies exact env overrides', async () => {
    const asyncSource: Source = {
      id: 'async',
      kind: 'typed',
      load: async () => undefined,
    };
    const envSource: Source = {
      id: 'env',
      kind: 'string',
      load: () => ({ values: { value: 'original' }, location: 'process.env' }),
      loadSync: () => ({ values: { value: 'original' }, location: 'process.env' }),
    };
    const loaded = await loadSources([asyncSource, envSource], {
      name: 'app',
      cwd: '.',
      mode: undefined,
      env: {},
      argv: [],
      envPrefix: undefined,
    });
    expect(loaded).toHaveLength(1);
    expect(
      loadSourcesSync([asyncSource, envSource], {
        name: 'app',
        cwd: '.',
        mode: undefined,
        env: {},
        argv: [],
        envPrefix: undefined,
      }),
    ).toHaveLength(1);
    const overridden = applyEnvironmentOverrides(
      loaded,
      [envSource],
      {
        name: 'app',
        cwd: '.',
        mode: undefined,
        env: { EXACT: 'forced' },
        argv: [],
        envPrefix: undefined,
      },
      { value: 'EXACT' },
    );
    expect(overridden[0]?.values).toEqual({ value: 'forced' });
    expect(
      applyEnvironmentOverrides(
        loaded,
        [envSource],
        {
          name: 'app',
          cwd: '.',
          mode: undefined,
          env: {},
          argv: [],
          envPrefix: undefined,
        },
        undefined,
      ),
    ).toBe(loaded);
  });
});
