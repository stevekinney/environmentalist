/* eslint-disable typescript/no-unsafe-type-assertion */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createEnvironment, toStore } from './svelte.js';
import type { Environment } from './types.js';
import type { Watcher } from './watch/watcher.js';

describe('Svelte bindings', () => {
  it('updates the getter-backed current value through a plain subscription', () => {
    const schema = z.object({ VALUE: z.string() });
    let current = { value: 'one' } as unknown as Environment<typeof schema>;
    const subscribers = new Set<(environment: Environment<typeof schema>) => void>();
    const watcher = {
      subscribe(callback: (environment: Environment<typeof schema>) => void) {
        subscribers.add(callback);
        return () => subscribers.delete(callback);
      },
      getSnapshot: () => current,
      getServerSnapshot: () => current,
    } as unknown as Watcher<typeof schema>;

    const view = createEnvironment(watcher);
    expect(view.current.value).toBe('one');
    current = { value: 'two' } as unknown as Environment<typeof schema>;
    subscribers.forEach((subscriber) => subscriber(current));
    expect(view.current.value).toBe('two');

    const values: string[] = [];
    const unsubscribe = toStore(watcher).subscribe((environment) => values.push(environment.value));
    expect(values).toEqual(['two']);
    unsubscribe();
  });
});
