import type { Platform } from './types.js';

type IdleDeadline = { readonly timeRemaining: () => number; readonly didTimeout: boolean };
type IdleScheduler = {
  readonly requestIdleCallback?: (callback: (deadline: IdleDeadline) => void) => number;
  readonly cancelIdleCallback?: (handle: number) => void;
};

function scheduleIdle(callback: () => void): () => void {
  const idle = globalThis as typeof globalThis & IdleScheduler;
  if (idle.requestIdleCallback !== undefined) {
    const handle = idle.requestIdleCallback(() => callback());
    return () => idle.cancelIdleCallback?.(handle);
  }

  const handle = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(handle);
}

/** Browser platform scheduler, preferring requestIdleCallback when available. */
export const platform: Platform = { name: 'browser', scheduleIdle };
