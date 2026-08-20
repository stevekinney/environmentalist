import { describe, expect, it } from 'bun:test';

import { expandEnv } from './expand-env.js';

describe('expandEnv', () => {
  it('expands a braced reference to another parsed value', () => {
    const parsed: Record<string, string> = { BASE: 'production', EXPANDED: '${BASE}' };
    expandEnv({ parsed, processEnv: {} });
    expect(parsed['EXPANDED']).toBe('production');
  });

  it('expands an unbraced reference', () => {
    const parsed: Record<string, string> = { BASE: 'production', EXPANDED: '$BASE' };
    expandEnv({ parsed, processEnv: {} });
    expect(parsed['EXPANDED']).toBe('production');
  });

  it('prefers a pre-existing processEnv value over the parsed value', () => {
    const parsed: Record<string, string> = { BASE: 'from-file' };
    const processEnv: Record<string, string | undefined> = { BASE: 'from-shell' };
    expandEnv({ parsed, processEnv });
    expect(parsed['BASE']).toBe('from-shell');
  });

  it('falls back to the "-" default when the key is unset', () => {
    const parsed: Record<string, string> = { EXPANDED: '${MISSING-fallback}' };
    expandEnv({ parsed, processEnv: {} });
    expect(parsed['EXPANDED']).toBe('fallback');
  });

  it('falls back to the ":-" default when the key is unset', () => {
    const parsed: Record<string, string> = { EXPANDED: '${MISSING:-fallback}' };
    expandEnv({ parsed, processEnv: {} });
    expect(parsed['EXPANDED']).toBe('fallback');
  });

  it('uses the "+" alternate value when the key is set', () => {
    const parsed: Record<string, string> = { BASE: 'production', EXPANDED: '${BASE+alternate}' };
    expandEnv({ parsed, processEnv: {} });
    expect(parsed['EXPANDED']).toBe('alternate');
  });

  it('resolves to empty when the "+" key is unset', () => {
    const parsed: Record<string, string> = { EXPANDED: '${MISSING+alternate}' };
    expandEnv({ parsed, processEnv: {} });
    expect(parsed['EXPANDED']).toBe('');
  });

  it('uses the ":+" alternate value when the key is set', () => {
    const parsed: Record<string, string> = { BASE: 'production', EXPANDED: '${BASE:+alternate}' };
    expandEnv({ parsed, processEnv: {} });
    expect(parsed['EXPANDED']).toBe('alternate');
  });

  it('resolves to empty when the ":+" key is unset', () => {
    const parsed: Record<string, string> = { EXPANDED: '${MISSING:+alternate}' };
    expandEnv({ parsed, processEnv: {} });
    expect(parsed['EXPANDED']).toBe('');
  });

  it('resolves escaped "$" sequences literally', () => {
    const parsed: Record<string, string> = { LITERAL: '\\$NOT_EXPANDED' };
    expandEnv({ parsed, processEnv: {} });
    expect(parsed['LITERAL']).toBe('$NOT_EXPANDED');
  });

  it('breaks self-referential expansion instead of looping', () => {
    const parsed: Record<string, string> = { SELF: '${SELF-fallback}' };
    expandEnv({ parsed, processEnv: {} });
    expect(parsed['SELF']).toBe('fallback');
  });

  it('populates processEnv with every resolved key', () => {
    const parsed: Record<string, string> = { BASE: 'production' };
    const processEnv: Record<string, string | undefined> = {};
    expandEnv({ parsed, processEnv });
    expect(processEnv['BASE']).toBe('production');
  });
});
