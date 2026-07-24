import { normalizeKeys } from '../../keys.js';
import type { Source, SourceContext, SourceResult } from '../../types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getDefaultStorage(): Storage | undefined {
  try {
    return (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
  } catch {
    return undefined;
  }
}

function loadLocalStorage(
  context: SourceContext,
  storage: Storage | undefined,
  key: string | undefined,
): SourceResult | undefined {
  const target = storage ?? getDefaultStorage();
  if (target === undefined) return undefined;

  try {
    const serialized = target.getItem(key ?? `environmentalist:${context.name}`);
    if (serialized === null) return undefined;
    const value: unknown = JSON.parse(serialized);
    return isPlainObject(value)
      ? { values: normalizeKeys(value), location: `localStorage:${key ?? context.name}` }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Create a synchronous source backed by a JSON object in localStorage. */
export function createLocalStorageSource(
  options: { readonly storage?: Storage; readonly key?: string } = {},
): Source {
  return {
    id: 'local-storage',
    kind: 'typed',
    load: (context) => loadLocalStorage(context, options.storage, options.key),
    loadSync: (context) => loadLocalStorage(context, options.storage, options.key),
  };
}
