/* eslint-disable no-underscore-dangle, typescript/no-unsafe-type-assertion */

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  EnvironmentalistError,
  createWatcher,
  environmentalist,
  secret,
  toPublic,
} from '../src/index.browser.js';

GlobalRegistrator.register();

type BrowserWindow = {
  readonly localStorage: Storage;
  readonly location: { href: string; readonly search: string };
  readonly addEventListener: typeof globalThis.addEventListener;
  readonly dispatchEvent: (event: Event) => boolean;
};

function browserWindow(): BrowserWindow {
  return Reflect.get(globalThis, 'window') as BrowserWindow;
}

function resetBrowser(): void {
  const window = browserWindow();
  window.localStorage.clear();
  window.location.href = 'https://example.test/';
  Reflect.deleteProperty(globalThis, '__BOWOWWOW__');
}

afterEach(() => resetBrowser());
afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('browser adapter', () => {
  it('resolves URL, injected, localStorage, and defaults in precedence order', async () => {
    const window = browserWindow();
    window.location.href = 'https://example.test/?value=url&api-key=url-secret';
    Reflect.set(globalThis, '__BOWOWWOW__', {
      VALUE: 'global',
      API_KEY: 'global-secret',
    });
    window.localStorage.setItem(
      'environmentalist:bowowwow',
      JSON.stringify({ VALUE: 'local', LOCAL_ONLY: 'local-value' }),
    );
    const schema = z.object({
      VALUE: z.string(),
      API_KEY: secret(z.string()),
      LOCAL_ONLY: z.string(),
      DEFAULTED: z.string().default('default'),
    });

    const environment = await environmentalist({ name: 'bowowwow', schema });
    expect(environment.value).toBe('url');
    expect(environment.apiKey).toBe('global-secret');
    expect(environment.localOnly).toBe('local-value');
    expect(environment.defaulted).toBe('default');
    expect(toPublic(environment)).toEqual({
      value: 'url',
      localOnly: 'local-value',
      defaulted: 'default',
    });
    expect(environmentalist.sync({ name: 'bowowwow', schema }).value).toBe('url');
    const explicit = await environmentalist({
      name: 'bowowwow',
      schema: z.object({ VALUE: z.string() }),
      search: '?value=explicit',
      sources: ['search-params'],
    });
    expect(explicit.value).toBe('explicit');
    expect(environmentalist.safeSync({ name: 'bowowwow', schema }).success).toBe(true);
    const safe = await environmentalist.safe({
      name: 'bowowwow',
      schema: z.object({ REQUIRED: z.string() }),
    });
    expect(safe.success).toBe(false);
    expect(
      environmentalist.safeSync({ name: 'bowowwow', schema: z.object({ REQUIRED: z.string() }) })
        .success,
    ).toBe(false);
  });

  it('responds to a cross-tab localStorage event with a change', async () => {
    const window = browserWindow();
    window.localStorage.setItem('environmentalist:bowowwow', JSON.stringify({ VALUE: 'one' }));
    const schema = z.object({ VALUE: z.string() });
    const watcher = environmentalist.watch({ name: 'bowowwow', schema, interval: 10 });
    await watcher.ready;
    const directWatcher = createWatcher({ name: 'bowowwow', schema, interval: 10 });
    await directWatcher.ready;
    await directWatcher.close();
    const change = new Promise<{ readonly changes: readonly unknown[] }>((_resolve) => {
      watcher.once('change', _resolve);
    });
    window.localStorage.setItem('environmentalist:bowowwow', JSON.stringify({ VALUE: 'two' }));
    const StorageEventConstructor = (
      globalThis as typeof globalThis & {
        StorageEvent: new (type: string, init: { readonly key: string }) => Event;
      }
    ).StorageEvent;
    window.dispatchEvent(
      new StorageEventConstructor('storage', { key: 'environmentalist:bowowwow' }),
    );
    const event = await change;
    expect(event.changes).toContainEqual({
      key: 'value',
      from: 'one',
      to: 'two',
      source: 'local-storage',
    });
    await watcher.close();
  });

  it('resolves explicit and window search values identically', async () => {
    const window = browserWindow();
    const schema = z.object({ VALUE: z.string(), TAGS: z.array(z.string()) });
    const explicit = await environmentalist({
      name: 'bowowwow',
      schema,
      search: '?value=from-search&tags=one&tags=two',
      sources: ['search-params'],
    });
    window.location.href = 'https://example.test/?value=from-search&tags=one&tags=two';
    const fromWindow = await environmentalist({
      name: 'bowowwow',
      schema,
      sources: ['search-params'],
    });

    expect(fromWindow).toMatchObject({ value: explicit.value, tags: explicit.tags });
  });

  it('accepts custom sources and reports browser-safe resolver errors', async () => {
    const schema = z.object({ VALUE: z.string() });
    const custom = {
      id: 'custom-browser',
      kind: 'typed' as const,
      load: () => ({ values: { VALUE: 'custom' }, location: 'test' }),
      loadSync: () => ({ values: { VALUE: 'custom' }, location: 'test' }),
    };
    const customEnvironment = await environmentalist({
      name: 'bowowwow',
      schema,
      sources: [custom],
    });
    expect(customEnvironment.value).toBe('custom');
    const unsupported = environmentalist.safeSync({
      name: 'bowowwow',
      schema,
      sources: ['env'],
    });
    expect(unsupported.success).toBe(false);
    if (!unsupported.success) expect(unsupported.error).toBeInstanceOf(EnvironmentalistError);
  });
});
