import { describe, expect, it } from 'bun:test';

import { createSearchParamsSource } from './search-params.js';
import type { SourceContext } from './types.js';

const context: SourceContext = {
  name: 'test',
  cwd: '.',
  mode: undefined,
  env: {},
  argv: [],
  envPrefix: undefined,
};

describe('createSearchParamsSource', () => {
  it('reads a string with a leading question mark', () => {
    expect(createSearchParamsSource({ search: '?api-key=value' }).loadSync?.(context)).toEqual({
      values: { apiKey: 'value' },
      location: 'search-params',
    });
  });

  it('reads URL and URLSearchParams inputs', () => {
    const url = new URL('https://example.test/?server.port=3000');
    expect(createSearchParamsSource({ search: url }).loadSync?.(context)?.values).toEqual({
      server: { port: '3000' },
    });
    expect(
      createSearchParamsSource({ search: new URLSearchParams('mode=dev') }).loadSync?.(context),
    ).toEqual({ values: { mode: 'dev' }, location: 'search-params' });
  });

  it('accumulates repeats and nests dot paths', () => {
    expect(
      createSearchParamsSource({ search: '?tag=a&tag=b&server.port=3000' }).loadSync?.(context)
        ?.values,
    ).toEqual({ tag: ['a', 'b'], server: { port: '3000' } });
  });

  it('omits secret keys', () => {
    expect(
      createSearchParamsSource({ search: '?token=hidden&mode=dev' }).loadSync?.({
        ...context,
        secretKeys: new Set(['token']),
      })?.values,
    ).toEqual({ mode: 'dev' });
  });

  it('uses window search when available and is safe without it', () => {
    const originalWindow: unknown = Reflect.get(globalThis, 'window');
    try {
      Reflect.set(globalThis, 'window', { location: { search: '?mode=test' } });
      expect(createSearchParamsSource().loadSync?.(context)?.values).toEqual({ mode: 'test' });
      Reflect.deleteProperty(globalThis, 'window');
      expect(createSearchParamsSource().loadSync?.(context)).toBeUndefined();
    } finally {
      if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
      else Reflect.set(globalThis, 'window', originalWindow);
    }
  });
});
