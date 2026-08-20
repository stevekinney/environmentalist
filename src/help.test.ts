import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { generateHelp } from './help.js';
import { registry, secret } from './metadata.js';

describe('generateHelp', () => {
  const schema = z.object({
    mode: z.string().default('development'),
    PORT: z.number().default(3000),
    ANTHROPIC_API_KEY: secret(z.string()),
    label: z.string().optional(),
  });

  it('renders a title, usage line, and one row per top-level flag', () => {
    const help = generateHelp({ name: 'bowowwow', schema, description: 'A tool' });
    expect(help).toContain('bowowwow — A tool');
    expect(help).toContain('Usage: bowowwow [flags]');
    expect(help).toContain('--mode <string>');
    expect(help).toContain('(default: "development")');
    expect(help).toContain('--port <number>');
    expect(help).toContain('--anthropic-api-key <string>');
    expect(help).toContain('(secret)');
    expect(help).toContain('(required)');
    expect(help).toContain('--label <string>');
  });

  it('omits the description separator when no description is given', () => {
    const help = generateHelp({ name: 'bowowwow', schema: z.object({}) });
    expect(help.startsWith('bowowwow\n')).toBe(true);
  });

  it('honors a forced flag spelling from schema metadata', () => {
    const overridden = z.object({
      databaseUrl: z.string().register(registry, { flag: 'db-url' }),
    });
    expect(generateHelp({ name: 'app', schema: overridden })).toContain('--db-url <string>');
  });

  it('includes a metadata description for a field', () => {
    const described = z.object({
      port: z.number().default(3000).register(registry, { description: 'Server port' }),
    });
    expect(generateHelp({ name: 'app', schema: described })).toContain('Server port');
  });

  it('renders positionals in the usage line and a Positionals section', () => {
    const help = generateHelp({
      name: 'app',
      schema: z.object({}),
      positionals: [
        { name: 'command', description: 'Which command to run' },
        { name: 'files', variadic: true, description: 'Files to process' },
      ],
    });
    expect(help).toContain('Usage: app <command> [files...] [flags]');
    expect(help).toContain('Positionals:');
    expect(help).toContain('<command>');
    expect(help).toContain('Which command to run');
    expect(help).toContain('[files...]');
    expect(help).toContain('Files to process');
  });

  it('supports a caller-supplied usage line', () => {
    const help = generateHelp({ name: 'app', schema: z.object({}), usage: 'app <custom>' });
    expect(help).toContain('Usage: app <custom>');
  });

  it('supports legacy schema and field definitions', () => {
    const legacyDefField = { _zod: { parent: null }, def: { type: 'string' } };
    const doubleLegacyField = { _zod: { parent: null }, _def: { type: 'number' } };
    const bareField = { _zod: { parent: null } };
    const legacySchema = {
      _zod: { parent: null },
      def: {
        type: 'object',
        shape: { first: legacyDefField, second: doubleLegacyField, third: bareField },
      },
    } as unknown as z.ZodObject;

    const help = generateHelp({ name: 'app', schema: legacySchema });
    expect(help).toContain('--first <string>');
    expect(help).toContain('--second <number>');
    expect(help).toContain('--third <value>');
  });

  it('falls back to String() when a default value cannot be JSON-stringified', () => {
    const withBigIntDefault = z.object({ big: z.bigint().default(10n) });
    expect(generateHelp({ name: 'app', schema: withBigIntDefault })).toContain('(default: 10)');
  });
});
