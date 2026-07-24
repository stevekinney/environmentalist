import type { Environment } from './types.js';
import type { Watcher } from './watch/watcher.js';
import type { z } from 'zod';

/** A getter-backed environment view for use from a Svelte 5 component. */
export type EnvironmentView<S extends z.ZodObject> = {
  readonly current: Environment<S>;
};

/**
 * Keep a getter-backed view synchronized with a watcher subscription.
 *
 * This is intentionally compiler-free. In a Svelte 5 component, consumers can
 * wrap the returned view in `$state`; a `.svelte.ts` rune wrapper is omitted
 * because Bun's test runner does not compile Svelte source files.
 */
export function createEnvironment<S extends z.ZodObject>(watcher: Watcher<S>): EnvironmentView<S> {
  let current = watcher.getSnapshot();
  watcher.subscribe((environment) => {
    current = environment;
  });
  return {
    get current(): Environment<S> {
      return current;
    },
  };
}

/** Adapt a watcher to Svelte's immediate-subscription store shape. */
export function toStore<S extends z.ZodObject>(
  watcher: Watcher<S>,
): {
  subscribe(run: (environment: Environment<S>) => void): () => void;
} {
  return {
    subscribe(run) {
      run(watcher.getSnapshot());
      return watcher.subscribe(run);
    },
  };
}
