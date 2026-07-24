import { describe, expect, it } from 'bun:test';

import type { SourceContext } from '../../types.js';
import {
  createInjectedGlobalSource,
  createImportMetaEnvSource,
  createLocalStorageSource,
} from './index.js';

const context: SourceContext = {
  name: 'bowowwow',
  cwd: '.',
  mode: undefined,
  env: {},
  argv: [],
  envPrefix: undefined,
};

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }
  clear(): void {
    this.#values.clear();
  }
  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

describe('browser sources', () => {
  it('reads and normalizes the default injected global', () => {
    const globalName = '__BOWOWWOW__';
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const previous = globals[globalName];
    globals[globalName] = { SERVER__PORT: 3000, API_KEY: 'key' };
    try {
      expect(createInjectedGlobalSource().loadSync?.(context)).toEqual({
        values: { serverPort: 3000, apiKey: 'key' },
        location: 'globalThis.__BOWOWWOW__',
      });
    } finally {
      if (previous === undefined) delete globals[globalName];
      else globals[globalName] = previous;
    }
  });

  it('ignores absent and non-plain injected globals', () => {
    const source = createInjectedGlobalSource({ globalName: '__MISSING__' });
    expect(source.loadSync?.(context)).toBeUndefined();
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    globals['__MISSING__'] = [];
    try {
      expect(source.loadSync?.(context)).toBeUndefined();
    } finally {
      delete globals['__MISSING__'];
    }
  });

  it('reads localStorage and tolerates malformed JSON', () => {
    const storage = new MemoryStorage();
    storage.setItem('environmentalist:bowowwow', '{"SERVER__PORT":3000,"MODE":"test"}');
    const source = createLocalStorageSource({ storage });
    expect(source.loadSync?.(context)?.values).toEqual({ serverPort: 3000, mode: 'test' });
    storage.setItem('environmentalist:bowowwow', '{malformed');
    expect(source.loadSync?.(context)).toBeUndefined();
    storage.setItem('custom', '[]');
    expect(
      createLocalStorageSource({ storage, key: 'custom' }).loadSync?.(context),
    ).toBeUndefined();
    storage.removeItem('custom');
    expect(
      createLocalStorageSource({ storage, key: 'custom' }).loadSync?.(context),
    ).toBeUndefined();
  });

  it('handles a throwing default localStorage getter', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('storage unavailable');
      },
    });
    try {
      expect(createLocalStorageSource().loadSync?.(context)).toBeUndefined();
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', descriptor);
    }
  });

  it('reads an injected import.meta.env record with nesting', () => {
    const source = createImportMetaEnvSource({ env: { SERVER__PORT: '3000', API_KEY: 'key' } });
    expect(source.loadSync?.(context)).toEqual({
      values: { server: { port: '3000' }, apiKey: 'key' },
      location: 'import.meta.env',
    });
  });
});
