import { describe, expect, it } from 'bun:test';

import { createFlagsSource, matchPositionals, parseFlags, parsePositionals } from './flags.js';

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

describe('parsePositionals', () => {
  it('collects arguments that are not flags or flag values', () => {
    expect(parsePositionals(['build', 'src/index.ts', '--verbose'])).toEqual([
      'build',
      'src/index.ts',
    ]);
  });

  it('collects everything after a bare terminator', () => {
    expect(parsePositionals(['run', '--', '--not-a-flag', 'value'])).toEqual([
      'run',
      '--not-a-flag',
      'value',
    ]);
  });

  it('treats a lone dash as positional', () => {
    expect(parsePositionals(['-'])).toEqual(['-']);
  });

  it('does not double count a flag value as positional', () => {
    expect(parsePositionals(['--tag', 'a', 'rest'])).toEqual(['rest']);
  });
});

describe('matchPositionals', () => {
  it('matches required and optional entries by order', () => {
    expect(
      matchPositionals(['build'], [{ name: 'command' }, { name: 'target', required: false }]),
    ).toEqual({ command: 'build' });
  });

  it('collects a variadic tail', () => {
    expect(
      matchPositionals(
        ['cp', 'a', 'b', 'c'],
        [{ name: 'command' }, { name: 'files', variadic: true }],
      ),
    ).toEqual({ command: 'cp', files: ['a', 'b', 'c'] });
  });

  it('allows an empty variadic tail by default', () => {
    expect(
      matchPositionals(['cp'], [{ name: 'command' }, { name: 'files', variadic: true }]),
    ).toEqual({ command: 'cp', files: [] });
  });

  it('throws when a required entry is missing', () => {
    expect(() => matchPositionals([], [{ name: 'command' }])).toThrow(
      'Missing required positional argument "command".',
    );
  });

  it('throws when a required variadic tail is empty', () => {
    expect(() =>
      matchPositionals(
        ['cp'],
        [{ name: 'command' }, { name: 'files', variadic: true, required: true }],
      ),
    ).toThrow('Missing required positional argument "files".');
  });

  it('throws on an unexpected extra positional', () => {
    expect(() => matchPositionals(['build', 'extra'], [{ name: 'command' }])).toThrow(
      'Unexpected positional argument "extra"; only 1 positional argument accepted.',
    );
  });

  it('throws when a non-trailing entry is variadic', () => {
    expect(() =>
      matchPositionals([], [{ name: 'files', variadic: true }, { name: 'command' }]),
    ).toThrow('Invalid positional spec: "files" is variadic but is not the last entry.');
  });

  it('throws when a required entry follows an optional one', () => {
    expect(() =>
      matchPositionals([], [{ name: 'target', required: false }, { name: 'command' }]),
    ).toThrow('Invalid positional spec: required "command" follows optional "target".');
  });
});
