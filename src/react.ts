import { useSyncExternalStore } from 'react';

import type { Watcher } from './watch/watcher.js';
import type { Environment } from './types.js';
import type { z } from 'zod';

/** Bind a watcher snapshot to React's concurrent-safe external-store API. */
export function useEnvironment<S extends z.ZodObject>(watcher: Watcher<S>): Environment<S> {
  return useSyncExternalStore(
    watcher.subscribe,
    watcher.getSnapshot,
    watcher.getServerSnapshot ?? watcher.getSnapshot,
  );
}
