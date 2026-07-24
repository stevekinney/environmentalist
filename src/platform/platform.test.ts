import { describe, expect, it } from 'bun:test';

import { platform as browserPlatform } from './browser.js';
import { platform as nodePlatform } from './node.js';

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('platform idle scheduling', () => {
  it('uses the Node scheduler postTask branch and aborts it', async () => {
    const globals = globalThis as typeof globalThis & { scheduler?: unknown };
    const previous = globals.scheduler;
    let called = false;
    let aborted = false;
    globals.scheduler = {
      postTask: async (callback: () => void, options: { signal: AbortSignal }) => {
        called = options.signal instanceof AbortSignal;
        callback();
      },
    };
    try {
      const cancel = nodePlatform.scheduleIdle(() => undefined);
      await delay();
      cancel();
      aborted = called;
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globals, 'scheduler');
      else globals.scheduler = previous;
    }
    expect(aborted).toBe(true);
  });

  it('swallows a rejected Node scheduler task', async () => {
    const globals = globalThis as typeof globalThis & { scheduler?: unknown };
    const previous = globals.scheduler;
    globals.scheduler = { postTask: () => Promise.reject(new Error('scheduler failed')) };
    try {
      nodePlatform.scheduleIdle(() => undefined)();
      await delay();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globals, 'scheduler');
      else globals.scheduler = previous;
    }
  });

  it('uses the Node timeout fallback when setImmediate is absent', async () => {
    const original = globalThis.setImmediate;
    Reflect.deleteProperty(globalThis, 'setImmediate');
    let fired = false;
    try {
      const cancel = nodePlatform.scheduleIdle(() => {
        fired = true;
      });
      await delay();
      cancel();
    } finally {
      Reflect.set(globalThis, 'setImmediate', original);
    }
    expect(fired).toBe(true);
  });

  it('fires and cancels Node callbacks', async () => {
    let fired = false;
    nodePlatform.scheduleIdle(() => {
      fired = true;
    })();
    await delay();
    expect(fired).toBe(false);

    nodePlatform.scheduleIdle(() => {
      fired = true;
    });
    await delay();
    expect(fired).toBe(true);
  });

  it('fires and cancels browser callbacks', async () => {
    let fired = false;
    browserPlatform.scheduleIdle(() => {
      fired = true;
    })();
    await delay();
    expect(fired).toBe(false);

    browserPlatform.scheduleIdle(() => {
      fired = true;
    });
    await delay();
    expect(fired).toBe(true);
  });

  it('uses requestIdleCallback when the browser provides it', () => {
    const globals = globalThis as typeof globalThis & {
      requestIdleCallback?: (callback: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const previousRequest = globals.requestIdleCallback;
    const previousCancel = globals.cancelIdleCallback;
    let canceled = 0;
    globals.requestIdleCallback = (callback) => {
      callback();
      return 7;
    };
    globals.cancelIdleCallback = (handle) => {
      canceled = handle;
    };
    try {
      let fired = false;
      const cancel = browserPlatform.scheduleIdle(() => {
        fired = true;
      });
      cancel();
      expect(fired).toBe(true);
    } finally {
      if (previousRequest === undefined) Reflect.deleteProperty(globals, 'requestIdleCallback');
      else globals.requestIdleCallback = previousRequest;
      if (previousCancel === undefined) Reflect.deleteProperty(globals, 'cancelIdleCallback');
      else globals.cancelIdleCallback = previousCancel;
    }
    expect(canceled).toBe(7);
  });
});
