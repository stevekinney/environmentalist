import { canonicalizeKey, normalizeKeys } from '../../keys.js';

/** Convert a flat canonical record with dotted keys into a nested record. */
export function nestRecord(record: Record<string, unknown>): Record<string, unknown> {
  const nested: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    const segments = key.split('.');
    let target = nested;

    for (const segment of segments.slice(0, -1)) {
      const child = target[segment];
      if (isRecord(child)) {
        target = child;
      } else {
        const created: Record<string, unknown> = {};
        target[segment] = created;
        target = created;
      }
    }

    const last = segments.at(-1);
    if (last !== undefined) {
      target[last] = value;
    }
  }

  return nested;
}

/** Normalize flat source entries and apply the shared dotted-key nesting rule. */
export function normalizeFlatEntries(
  entries: Iterable<readonly [string, unknown]>,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    flat[canonicalizeKey(key)] = value;
  }
  return nestRecord(normalizeKeys(flat));
}

/** Test whether a value can be used as a configuration object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Return a record after normalizing its keys, or undefined for non-object exports. */
export function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? normalizeKeys(value) : undefined;
}
