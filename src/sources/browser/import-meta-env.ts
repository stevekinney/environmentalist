import { applyForcedEnvNames } from '../../coerce.js';
import { normalizeKeys, tryCanonicalizeKey } from '../../keys.js';
import type { Source, SourceContext, SourceResult } from '../../types.js';

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

function loadImportMetaEnv(
  env: Record<string, unknown> | undefined,
  overrides: Readonly<Record<string, string>> | undefined,
): SourceResult | undefined {
  if (env === undefined || Object.keys(env).length === 0) return undefined;
  const named = Object.entries(env).map(
    ([key, value]) => [key.replaceAll('__', '.'), value] as const,
  );
  const entries: Array<readonly [string, unknown]> = [];
  for (const [key, value] of applyForcedEnvNames(named, overrides)) {
    const canonical = tryCanonicalizeKey(key);
    if (canonical === undefined) continue;

    entries.push([canonical, value]);
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
    load: (context: SourceContext) => loadImportMetaEnv(options.env, context.envOverrides),
    loadSync: (context: SourceContext) => loadImportMetaEnv(options.env, context.envOverrides),
  };
}
