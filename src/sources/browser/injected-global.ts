import { constantCase } from 'change-case';

import { normalizeKeys } from '../../keys.js';
import type { Source, SourceContext, SourceResult } from '../../types.js';

type GlobalRecord = typeof globalThis & Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function loadInjectedGlobal(
  context: SourceContext,
  globalName: string | undefined,
): SourceResult | undefined {
  const name = globalName ?? `__${constantCase(context.name)}__`;
  const value = (globalThis as GlobalRecord)[name];
  return isPlainObject(value)
    ? { values: normalizeKeys(value), location: `globalThis.${name}` }
    : undefined;
}

/** Create a synchronous source backed by an injected global configuration object. */
export function createInjectedGlobalSource(options: { readonly globalName?: string } = {}): Source {
  return {
    id: 'injected-global',
    kind: 'typed',
    load: (context) => loadInjectedGlobal(context, options.globalName),
    loadSync: (context) => loadInjectedGlobal(context, options.globalName),
  };
}
