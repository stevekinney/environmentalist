/* eslint-disable typescript/no-unsafe-type-assertion */

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { useEnvironment } from './react.js';
import type { Environment } from './types.js';
import type { Watcher } from './watch/watcher.js';

GlobalRegistrator.register();
const React = await import('react');
const testingLibrary = await import('@testing-library/react');
afterAll(async () => GlobalRegistrator.unregister());

describe('React binding', () => {
  it('re-renders on a changed snapshot and not on an unchanged snapshot', async () => {
    const { act, cleanup, render } = testingLibrary;
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
    let renders = 0;
    function Component(): React.JSX.Element {
      renders += 1;
      const environment = useEnvironment(watcher);
      return React.createElement('span', null, environment.value);
    }

    const view = render(React.createElement(Component));
    expect((view.container as unknown as { textContent: string | null }).textContent).toBe('one');
    expect(renders).toBe(1);
    await act(async () => {
      subscribers.forEach((subscriber) => subscriber(current));
    });
    expect(renders).toBe(1);
    await act(async () => {
      current = { value: 'two' } as unknown as Environment<typeof schema>;
      subscribers.forEach((subscriber) => subscriber(current));
    });
    expect((view.container as unknown as { textContent: string | null }).textContent).toBe('two');
    expect(renders).toBe(2);
    cleanup();
  });
});
