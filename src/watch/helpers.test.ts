import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

/* eslint-disable typescript/no-unsafe-type-assertion */

import { EnvironmentalistError } from '../errors.js';
import { SOURCES } from '../types.js';
import {
  asEnvironmentalistError,
  changedPaths,
  createIterator,
  deepEqual,
  initialChanges,
  valueAtPath,
} from './helpers.js';
import type { Environment } from '../types.js';

type TestEnvironment = Environment<z.ZodObject>;

function environment(values: Record<string, unknown>, sources: Record<string, unknown>) {
  Object.defineProperty(values, SOURCES, { value: sources });
  return values as unknown as TestEnvironment;
}

describe('watch helpers', () => {
  it('normalizes arbitrary errors and compares nested JSON-like values', () => {
    const environmentalistError = new EnvironmentalistError('existing');
    expect(asEnvironmentalistError(environmentalistError)).toBe(environmentalistError);
    expect(asEnvironmentalistError(new Error('ordinary')).message).toBe('ordinary');
    expect(asEnvironmentalistError('unknown').message).toBe('unknown');
    expect(deepEqual(new Date('2026-01-01'), new Date('2026-01-01'))).toBe(true);
    expect(deepEqual(new Date('2026-01-01'), new Date('2026-01-02'))).toBe(false);
    expect(deepEqual([1, { value: true }], [1, { value: true }])).toBe(true);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(deepEqual({ value: 1 }, { value: 2 })).toBe(false);
    expect(deepEqual({ value: 1 }, null)).toBe(false);
  });

  it('computes changed and initial provenance-backed paths', () => {
    const previous = environment(
      { nested: { value: 'old' }, same: true },
      {
        'nested.value': { source: 'env', location: 'OLD' },
        same: { source: 'env', location: 'SAME' },
      },
    );
    const current = environment(
      { nested: { value: 'new' }, added: 3, same: true },
      {
        'nested.value': { source: 'flags', location: '--nested.value' },
        added: { source: 'defaults', location: 'schema defaults' },
        same: { source: 'env', location: 'SAME' },
      },
    );

    expect(valueAtPath(current, 'nested.value')).toBe('new');
    expect(valueAtPath(current, 'nested.missing')).toBeUndefined();
    expect(valueAtPath('not-an-object', 'value')).toBeUndefined();
    expect(changedPaths(previous, current)).toEqual([
      { key: 'nested.value', from: 'old', to: 'new', source: 'flags' },
      { key: 'added', from: undefined, to: 3, source: 'defaults' },
    ]);
    expect(initialChanges(current)).toEqual([
      { key: 'nested.value', from: undefined, to: 'new', source: 'flags' },
      { key: 'added', from: undefined, to: 3, source: 'defaults' },
      { key: 'same', from: undefined, to: true, source: 'env' },
    ]);
  });

  it('coalesces iterator pushes, supports async iteration, and finishes pending reads', async () => {
    let removed = 0;
    const stored = createIterator<z.ZodObject>(() => {
      removed += 1;
    });
    const iterator = stored.iterator;
    expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
    const first = { value: 1 } as unknown as TestEnvironment;
    const pending = iterator.next();
    stored.push(first);
    const firstResult = await pending;
    expect(firstResult.value).toBe(first);
    const second = { value: 2 } as unknown as TestEnvironment;
    stored.push(second);
    const secondResult = await iterator.next();
    expect(secondResult.value).toBe(second);
    const waiting = iterator.next();
    const returned = await iterator.return?.();
    expect(returned?.done).toBe(true);
    const waitingResult = await waiting;
    expect(waitingResult.done).toBe(true);
    stored.push(first);
    stored.finish();
    expect(removed).toBe(1);
    const finishedResult = await iterator.next();
    expect(finishedResult.done).toBe(true);
  });
});
