import { describe, expect, it } from 'bun:test';

import { createFlagsSource, parseFlags } from './flags.js';

describe('parseFlags', () => {
  it('parses equals and space forms', () => {
    expect(parseFlags(['--name=value', '--other', 'value'])).toEqual({
      name: 'value',
      other: 'value',
    });
  });

  it('parses negation and presence', () => {
    expect(parseFlags(['--no-verbose', '--debug'])).toEqual({ verbose: false, debug: true });
  });

  it('accumulates repeated flags', () => {
    expect(parseFlags(['--tag', 'a', '--tag=b'])).toEqual({ tag: ['a', 'b'] });
  });

  it('maps aliases to canonical keys', () => {
    expect(parseFlags(['-k', 'secret'], { aliases: { k: 'apiKey' } })).toEqual({
      apiKey: 'secret',
    });
  });

  it('nests dot paths', () => {
    expect(parseFlags(['--server.port=3000'])).toEqual({ server: { port: '3000' } });
  });

  it('supports the terminator and mixed forms', () => {
    expect(parseFlags(['--first', 'one', '--second=two', '--', '--ignored', 'value'])).toEqual({
      first: 'one',
      second: 'two',
    });
  });

  it('supports forced flag spellings and source loading', () => {
    const source = createFlagsSource({
      argv: ['--legacy-name=value'],
      flagOverrides: { 'legacy-name': 'newName' },
    });
    expect(
      source.loadSync?.({
        name: 'test',
        cwd: '.',
        mode: undefined,
        env: {},
        argv: [],
        envPrefix: undefined,
      }),
    ).toEqual({ values: { newName: 'value' }, location: 'argv' });
  });
});
