import { camelCase, constantCase, kebabCase } from 'change-case';

import { EnvironmentalistError } from './errors.js';

const KEY_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/u;

function hasInvalidBoundary(segment: string): boolean {
  return (
    segment.length === 0 ||
    segment.startsWith('_') ||
    segment.endsWith('_') ||
    segment.startsWith('-') ||
    segment.endsWith('-') ||
    !KEY_SEGMENT_PATTERN.test(segment)
  );
}

function assertKey(key: string): void {
  if (key.length === 0 || key.startsWith('.') || key.endsWith('.') || key.includes('..')) {
    throw new EnvironmentalistError(
      `Invalid key "${key}": the key cannot round-trip between runtime and type-level transforms.`,
    );
  }

  for (const segment of key.split('.')) {
    if (hasInvalidBoundary(segment)) {
      throw new EnvironmentalistError(
        `Invalid key "${key}": the key cannot round-trip between runtime and type-level transforms.`,
      );
    }
  }
}

function mapSegments(key: string, transform: (segment: string) => string): string {
  assertKey(key);
  return key.split('.').map(transform).join('.');
}

function isUppercase(character: string | undefined): boolean {
  return character !== undefined && character >= 'A' && character <= 'Z';
}

function isLowercase(character: string | undefined): boolean {
  return character !== undefined && character >= 'a' && character <= 'z';
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

function shouldSplitWord(
  word: string,
  character: string | undefined,
  previous: string | undefined,
  next: string | undefined,
): boolean {
  return (
    word.length > 0 &&
    isUppercase(character) &&
    (isLowercase(previous) || isDigit(previous) || (isUppercase(previous) && isLowercase(next)))
  );
}

function transformWord(word: string, index: number): string {
  const lower = word.toLowerCase();
  if (index === 0) {
    return lower;
  }

  const first = lower[0];
  if (isDigit(first)) {
    return `_${first}${lower.slice(1)}`;
  }

  return `${first?.toUpperCase() ?? ''}${lower.slice(1)}`;
}

/**
 * Apply the same word-boundary algorithm as change-case's camelCase to one
 * key segment. This is exported for the runtime/type-level consistency test.
 *
 * @param input - An accepted, non-dotted key segment.
 * @returns The camelCase spelling of the segment.
 */
export function camelCaseReference(input: string): string {
  const words: string[] = [];
  let word = '';

  const flush = (): void => {
    if (word.length > 0) {
      words.push(word);
      word = '';
    }
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const previous = input[index - 1];
    const next = input[index + 1];

    if (character === '_' || character === '-') {
      flush();
      continue;
    }

    if (shouldSplitWord(word, character, previous, next)) {
      flush();
    }

    word += character;
  }
  flush();

  return words.map(transformWord).join('');
}

/**
 * Normalize a key to canonical camelCase, preserving dot-separated nesting.
 *
 * @param key - A key in any supported casing.
 * @returns The canonical camelCase key.
 * @throws {@link EnvironmentalistError} when the key cannot be represented by
 * the shared runtime and type-level transforms.
 */
export function canonicalizeKey(key: string): string {
  return mapSegments(key, (segment) => {
    return camelCase(segment);
  });
}

/**
 * Derive the environment-variable spelling of a canonical key.
 *
 * @param key - A canonical key, optionally with dot-separated nesting.
 * @param prefix - An optional environment-variable prefix.
 * @returns The constant-case environment-variable name.
 */
export function toEnvName(key: string, prefix?: string): string {
  const result = mapSegments(key, (segment) => constantCase(segment));
  return prefix === undefined || prefix.length === 0
    ? result.replaceAll('.', '__')
    : `${constantCase(prefix)}_${result.replaceAll('.', '__')}`;
}

/**
 * Derive the command-line spelling of a canonical key.
 *
 * @param key - A canonical key, optionally with dot-separated nesting.
 * @returns The kebab-case flag name without the leading `--`.
 */
export function toFlagName(key: string): string {
  return mapSegments(key, (segment) => kebabCase(segment));
}

/**
 * Derive the config-file spelling of a key.
 *
 * @param key - A key in any supported casing, optionally with dot nesting.
 * @returns The canonical camelCase config name.
 */
export function toConfigName(key: string): string {
  return canonicalizeKey(key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    normalized[canonicalizeKey(key)] = normalizeValue(child);
  }
  return normalized;
}

/**
 * Deeply normalize an incoming source record without mutating it.
 *
 * @param record - An object whose keys may use any supported casing.
 * @returns A new canonical-keyed record.
 */
export function normalizeKeys(record: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeValue(record);
  if (!isPlainRecord(normalized)) {
    throw new EnvironmentalistError('Expected a record of configuration values.');
  }
  return normalized;
}
