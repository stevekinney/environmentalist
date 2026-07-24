import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { createJiti } from 'jiti';

import type { ConfigLoader } from '../../types.js';

/** Strategies accepted by the runtime-aware configuration loader. */
export type LoaderStrategy = 'auto' | 'bun' | 'jiti' | ConfigLoader;

export type ModuleLoader = {
  readonly load: (location: string) => Promise<unknown>;
  readonly loadSync?: (location: string) => unknown;
};

function isBunRuntime(): boolean {
  return typeof process !== 'undefined' && process.versions?.['bun'] !== undefined;
}

function isNativeTypeScriptRuntime(): boolean {
  const globals = globalThis as Record<string, unknown>;
  return isBunRuntime() || 'Deno' in globals;
}

function interopDefault(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'default' in value) {
    return value.default;
  }
  return value;
}

/** Create a cached loader for JavaScript and TypeScript configuration modules. */
export function createConfigLoader(strategy: LoaderStrategy = 'auto'): ModuleLoader {
  if (typeof strategy === 'function') {
    return { load: async (location) => strategy(location), loadSync: strategy };
  }

  const selected = strategy === 'auto' ? (isNativeTypeScriptRuntime() ? 'bun' : 'jiti') : strategy;

  if (selected === 'jiti') {
    const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true });
    return {
      load: (location) => jiti.import(location, { default: true }),
      loadSync: (location) => jiti(location),
    };
  }

  const require = createRequire(import.meta.url);
  return {
    load: async (location) => interopDefault(await import(pathToFileURL(location).href)),
    loadSync: (location) => {
      if (!isBunRuntime() && /\.(?:ts|mts|cts)$/u.test(location)) {
        throw new Error(`Synchronous TypeScript loading requires Bun: ${location}`);
      }
      return interopDefault(require(location));
    },
  };
}
