/* eslint-disable typescript/no-unsafe-type-assertion */

/** Replacement used wherever a secret value would otherwise be displayed. */
export const MASKED = '[redacted]';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Replace one value with the standard secret mask. */
export function redactValue(_value: unknown): string {
  return MASKED;
}

function copyValue(value: unknown, path: string, secretKeys: ReadonlySet<string>): unknown {
  if (secretKeys.has(path)) return redactValue(value);
  if (Array.isArray(value)) return value.map((item) => copyValue(item, path, secretKeys));
  if (!isPlainObject(value)) return value;

  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    copy[key] = copyValue(child, childPath, secretKeys);
  }
  return copy;
}

/** Copy an object while masking canonical keys, including dotted nested paths. */
export function redactDeep<T extends object>(object: T, secretKeys: ReadonlySet<string>): T {
  return copyValue(object, '', secretKeys) as T;
}
