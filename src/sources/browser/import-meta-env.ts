import { canonicalizeKey, normalizeKeys } from '../../keys.js';
import type { Source, SourceResult } from '../../types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nestEntries(entries: Iterable<readonly [string, unknown]>): Record<string, unknown> {
  const nested: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const segments = key.split('.');
    let target = nested;
    for (const segment of segments.slice(0, -1)) {
      const child = target[segment];
      const next = isRecord(child) ? child : {};

      target[segment] = next;
      target = next;
    }
    const leaf = segments.at(-1);
    if (leaf !== undefined) target[leaf] = value;
  }
  return normalizeKeys(nested);
}

function loadImportMetaEnv(env: Record<string, unknown> | undefined): SourceResult | undefined {
  if (env === undefined || Object.keys(env).length === 0) return undefined;
  const entries: Array<readonly [string, unknown]> = [];
  for (const [key, value] of Object.entries(env)) {
    try {
      entries.push([canonicalizeKey(key.replaceAll('__', '.')), value]);
    } catch {
      continue;
    }
  }
  if (entries.length === 0) return undefined;
  return { values: nestEntries(entries), location: 'import.meta.env' };
}

/** Create a synchronous source for a bundler-injected import.meta.env record.
 * Pass Vite's import.meta.env through `options.env`; this module does not reference it directly.
 */
export function createImportMetaEnvSource(
  options: { readonly env?: Record<string, unknown> } = {},
): Source {
  return {
    id: 'import-meta-env',
    kind: 'string',
    load: () => loadImportMetaEnv(options.env),
    loadSync: () => loadImportMetaEnv(options.env),
  };
}
