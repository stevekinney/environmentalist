import { describe, expect, it } from 'bun:test';

import * as publicApi from './index.js';

describe('public API', () => {
  it('exports the documented runtime surface', () => {
    expect(Object.keys(publicApi).toSorted()).toEqual([
      'EnvironmentalistError',
      'SCHEMA',
      'SOURCES',
      'createUserDataConfigSource',
      'createWatcher',
      'defineConfig',
      'electronPaths',
      'environmentalist',
      'generateHelp',
      'matchPositionals',
      'parsePositionals',
      'registry',
      'secret',
      'toJSONSchema',
      'toPublic',
    ]);
  });

  it('does not expose the template API and does expose watch', () => {
    expect('greet' in publicApi).toBe(false);
    expect('parseEnvironment' in publicApi).toBe(false);
    expect(typeof publicApi.environmentalist.watch).toBe('function');
  });
});
