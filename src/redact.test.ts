/* eslint-disable typescript/no-unsafe-type-assertion */

import { describe, expect, it } from 'bun:test';

import { MASKED, redactDeep, redactValue } from './redact.js';

describe('redaction', () => {
  it('masks individual values', () => {
    expect(redactValue('secret')).toBe(MASKED);
  });

  it('copies objects and masks dotted canonical paths', () => {
    const source = { apiKey: 'secret', nested: { token: 'hidden', visible: 'shown' } };
    const result = redactDeep(source, new Set(['apiKey', 'nested.token']));

    expect(result).toEqual({ apiKey: MASKED, nested: { token: MASKED, visible: 'shown' } });
    expect(result).not.toBe(source);
    expect(result.nested).not.toBe(source.nested);
    expect(source.nested.token).toBe('hidden');
  });

  it('preserves arrays, null-prototype records, and primitive values', () => {
    const record = Object.create(null) as Record<string, unknown>;
    record['visible'] = 'shown';
    expect(redactDeep([record, null, 'value'], new Set())).toEqual([record, null, 'value']);
  });
});
