import type { Platform } from './types.js';

type Scheduler = {
  readonly postTask?: (
    callback: () => void,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<unknown>;
};

function scheduleIdle(callback: () => void): () => void {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: Scheduler }).scheduler;
  if (scheduler?.postTask !== undefined) {
    const controller = new AbortController();
    void scheduler.postTask(callback, { signal: controller.signal }).catch(() => undefined);
    return () => controller.abort();
  }

  if (typeof globalThis.setImmediate === 'function') {
    const handle = globalThis.setImmediate(callback);
    return () => {
      globalThis.clearImmediate(handle);
    };
  }

  const handle = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(handle);
}

/** Node-family platform scheduler, preferring native task scheduling. */
export const platform: Platform = { name: 'node', scheduleIdle };
