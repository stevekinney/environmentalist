/* eslint-disable typescript/no-unsafe-type-assertion */

import { describe, expect, it } from 'bun:test';
import { camelCase } from 'change-case';
import { array, assert, constantFrom, property } from 'fast-check';

import { EnvironmentalistError } from './errors.js';
import {
  camelCaseReference,
  canonicalizeKey,
  normalizeKeys,
  tryCanonicalizeKey,
  toConfigName,
  toEnvName,
  toFlagName,
} from './keys.js';

describe('canonical key utilities', () => {
  it('canonicalizes representative key spellings', () => {
    const cases = {
      ANTHROPIC_API_KEY: 'anthropicApiKey',
      AWS_REGION: 'awsRegion',
      s3Bucket: 's3Bucket',
      oauth2Token: 'oauth2Token',
      'server-port': 'serverPort',
      'server.port': 'server.port',
    };

    for (const [input, expected] of Object.entries(cases)) {
      expect(canonicalizeKey(input)).toBe(expected);
    }
  });

  it('derives source spellings from canonical nested keys', () => {
    expect(toEnvName('server.port')).toBe('SERVER__PORT');
    expect(toEnvName('server.port', 'bowowwow')).toBe('BOWOWWOW_SERVER__PORT');
    expect(toFlagName('server.port')).toBe('server.port');
    expect(toConfigName('SERVER.PORT')).toBe('server.port');
    expect(toConfigName('VALUE')).toBe('value');
  });

  it('normalizes nested records and objects inside arrays without mutation', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const input = {
      SERVER: { PORT: 3000 },
      ITEMS: [{ ITEM_ID: 1 }, 'unchanged', null],
      DATE: date,
    };

    expect(normalizeKeys(input)).toEqual({
      server: { port: 3000 },
      items: [{ itemId: 1 }, 'unchanged', null],
      date,
    });
    expect(input.SERVER.PORT).toBe(3000);
  });

  it('rejects key shapes that cannot be represented consistently', () => {
    for (const key of [
      '',
      '.server',
      'server.',
      'server..port',
      '-server',
      'server-',
      'server/port',
      'server port',
    ]) {
      expect(() => canonicalizeKey(key)).toThrow(EnvironmentalistError);
    }
  });

  it('skips rather than throws for ambient keys that cannot round-trip', () => {
    for (const key of ['', '.server', 'server.', 'server..port', '-server', 'server port']) {
      expect(tryCanonicalizeKey(key)).toBeUndefined();
    }

    expect(tryCanonicalizeKey('SERVER__PORT'.replaceAll('__', '.'))).toBe('server.port');
    expect(tryCanonicalizeKey('API_KEY')).toBe('apiKey');
  });

  it('rejects non-record values at the normalization boundary', () => {
    expect(() => normalizeKeys([] as never)).toThrow(EnvironmentalistError);
  });

  it('keeps the runtime reference transform aligned with change-case', () => {
    const letters = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-');
    const validKey = array(constantFrom(...letters), { minLength: 1, maxLength: 40 })
      .map((characters) => characters.join(''))
      .filter((key) => /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/u.test(key));

    assert(
      property(validKey, (key) => {
        expect(camelCaseReference(key)).toBe(camelCase(key));
        expect(canonicalizeKey(key)).toBe(camelCaseReference(key));
      }),
      { numRuns: 1_200 },
    );
  });
});
