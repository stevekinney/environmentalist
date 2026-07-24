import { EnvironmentalistError } from '../errors.js';
import { SOURCES } from '../types.js';
import type { Environment, Provenance } from '../types.js';
import type { z } from 'zod';
import type { EnvironmentChange } from './watcher.js';

/** Normalize arbitrary resolver failures to the public error type. */
export function asEnvironmentalistError(error: unknown): EnvironmentalistError {
  if (error instanceof EnvironmentalistError) return error;
  if (error instanceof Error) return new EnvironmentalistError(error.message);
  return new EnvironmentalistError(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function equalArrays(left: readonly unknown[], right: readonly unknown[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => deepEqual(value, right[index]))
  );
}

function equalRecords(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
  );
}

/** Deep comparison for the JSON-like values normally produced by a schema. */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (Array.isArray(left) && Array.isArray(right)) return equalArrays(left, right);
  if (!isRecord(left) || !isRecord(right)) return false;
  return equalRecords(left, right);
}

/** Read a canonical dotted path from a frozen environment. */
export function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function sourcesOf<S extends z.ZodObject>(
  environment: Environment<S>,
): Partial<Record<string, Provenance>> {
  return environment[SOURCES];
}

/** Compute changed canonical leaves and the source that now wins each one. */
export function changedPaths<S extends z.ZodObject>(
  previous: Environment<S>,
  environment: Environment<S>,
): EnvironmentChange[] {
  const previousSources = sourcesOf(previous);
  const currentSources = sourcesOf(environment);
  const keys = new Set([...Object.keys(previousSources), ...Object.keys(currentSources)]);
  const changes: EnvironmentChange[] = [];
  for (const key of keys) {
    const from = valueAtPath(previous, key);
    const to = valueAtPath(environment, key);
    if (!deepEqual(from, to)) changes.push({ key, from, to, source: currentSources[key]?.source });
  }
  return changes;
}

/** Compute the initial event payload when a watcher is configured to emit it. */
export function initialChanges<S extends z.ZodObject>(
  environment: Environment<S>,
): EnvironmentChange[] {
  const sources = sourcesOf(environment);
  return Object.keys(sources).map((key) => ({
    key,
    from: undefined,
    to: valueAtPath(environment, key),
    source: sources[key]?.source,
  }));
}

/** State held by one coalescing async iterator consumer. */
export type StoredIterator<S extends z.ZodObject> = {
  iterator: AsyncIterator<Environment<S>> & AsyncIterable<Environment<S>>;
  push(environment: Environment<S>): void;
  finish(): void;
};

/** Create an async iterator with one pending latest-snapshot slot. */
export function createIterator<S extends z.ZodObject>(
  remove: (stored: StoredIterator<S>) => void,
): StoredIterator<S> {
  let latest: Environment<S> | undefined;
  let pending: ((result: IteratorResult<Environment<S>>) => void) | undefined;
  let flushHandle: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  const flush = (): void => {
    flushHandle = undefined;
    if (finished || pending === undefined || latest === undefined) return;
    const resolve = pending;
    pending = undefined;
    const environment = latest;
    latest = undefined;
    resolve({ done: false, value: environment });
  };

  let stored: StoredIterator<S>;
  const iterator: AsyncIterator<Environment<S>> & AsyncIterable<Environment<S>> = {
    next: () => {
      if (finished) return Promise.resolve({ done: true, value: undefined });
      if (latest !== undefined) {
        const environment = latest;
        latest = undefined;
        return Promise.resolve({ done: false, value: environment });
      }
      return new Promise<IteratorResult<Environment<S>>>((resolve) => {
        pending = resolve;
      });
    },
    return: () => {
      stored.finish();
      return Promise.resolve({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  stored = {
    iterator,
    push: (environment) => {
      if (finished) return;
      latest = environment;
      if (pending !== undefined && flushHandle === undefined) {
        flushHandle = globalThis.setTimeout(flush, 0);
      }
    },
    finish: () => {
      if (finished) return;
      finished = true;
      if (flushHandle !== undefined) globalThis.clearTimeout(flushHandle);
      flushHandle = undefined;
      latest = undefined;
      pending?.({ done: true, value: undefined });
      pending = undefined;
      remove(stored);
    },
  };
  return stored;
}
