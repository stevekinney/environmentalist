/* eslint-disable max-lines, typescript/no-unsafe-type-assertion */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { main, runCliEntrypoint, runCliEntrypointIfMain } from './index.js';
import { findSchemaExpression, locateSchema, requireObjectSchema } from './locate-schema.js';
import { generateTypes } from './generate-types.js';
import { zodToType } from './zod-to-ts.js';
import { SCHEMA } from '../types.js';

const directories: string[] = [];
const fixture = resolve('src/cli/fixtures/environment.ts');

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'environmentalist-cli-'));
  directories.push(directory);
  return directory;
}

async function capture(
  run: () => Promise<number>,
): Promise<{ code: number; output: string; error: string }> {
  const output: string[] = [];
  const errors: string[] = [];
  const oldLog = globalThis.console.log;
  const oldError = globalThis.console.error;
  globalThis.console.log = (...args: unknown[]) => output.push(args.join(' '));
  globalThis.console.error = (...args: unknown[]) => errors.push(args.join(' '));
  try {
    return { code: await run(), output: output.join('\n'), error: errors.join('\n') };
  } finally {
    globalThis.console.log = oldLog;
    globalThis.console.error = oldError;
  }
}

async function runTsc(directory: string): Promise<string> {
  const child = Bun.spawn(
    ['bun', 'x', 'tsc', '--noEmit', '--project', join(directory, 'tsconfig.json')],
    {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [exitCode, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${output}\n${error}`);
  return `${output}${error}`;
}

describe('CLI schema and type generation', () => {
  it('generates the checked-in declaration with canonical keys', async () => {
    const generated = await generateTypes({ entry: fixture, typeName: 'FixtureEnvironment' });
    const expected = await readFile(resolve('src/cli/fixtures/environment.generated.d.ts'), 'utf8');
    expect(generated).toBe(expected);
    expect(generated).toContain('anthropicApiKey');
    expect(generated).not.toContain('ANTHROPIC_API_KEY');
  });

  it('prints the supported Zod v4 graph and makes defaults input-optional', () => {
    const schema = z.object({
      defaulted: z.string().default('value'),
      optional: z.string().optional(),
      nullable: z.string().nullable(),
      literal: z.literal('literal'),
      choice: z.enum(['one', 'two']),
      union: z.union([z.string(), z.number()]),
      values: z.array(z.boolean()),
      lookup: z.record(z.string(), z.string()),
      pair: z.tuple([z.string(), z.number()]),
      count: z.bigint(),
      date: z.date(),
      transformed: z.string().transform((value) => value.length),
      caught: z.string().catch('fallback'),
      literalNull: z.literal(null),
      anyValue: z.any(),
      unknownValue: z.unknown(),
      neverValue: z.never(),
      empty: z.object({}),
    });
    const output = zodToType(schema);
    const input = zodToType(schema, 'input');
    expect(output).toContain('readonly defaulted: string');
    expect(input).toContain('readonly defaulted?: string');
    expect(output).toContain('readonly transformed: unknown');
    expect(output).toContain('Array<boolean>');
    expect(output).toContain('Record<string, string>');
    expect(output).toContain('[string, number]');
    expect(output).toContain('bigint');
    expect(output).toContain('Date');
    expect(output).toContain('null');
    expect(output).toContain('never');
    expect(output).toContain('readonly empty: { };');
    expect(zodToType(z.null())).toBe('null');
    expect(zodToType(z.undefined())).toBe('undefined');
    expect(zodToType(z.tuple([z.string()], z.number()))).toBe('[string, number[]]');
    expect(
      zodToType({
        def: { type: 'literal', values: [{ unsupported: true }] },
      } as unknown as z.ZodType),
    ).toBe('unknown');
    expect(zodToType({ def: { type: 'enum', values: ['one', 2] } } as unknown as z.ZodType)).toBe(
      '"one" | 2',
    );
    expect(zodToType({ def: { type: 'union' } } as unknown as z.ZodType)).toBe('unknown');
    expect(zodToType(z.string().catch('fallback'))).toBe('string');
    expect(zodToType(z.string().default('fallback'))).toBe('string');
    expect(
      zodToType({ def: { type: 'catch', innerType: z.string() } } as unknown as z.ZodType),
    ).toBe('string');
    expect(zodToType({ _zod: { def: { type: 'unrecognized' } } } as unknown as z.ZodType)).toBe(
      'unknown',
    );
  });

  it('never imports a static target', async () => {
    const directory = await temporaryDirectory();
    const sentinel = join(directory, 'imported.sentinel');
    const entry = join(directory, 'side-effect.ts');
    const zodModule = resolve('node_modules/zod/index.js');
    await writeFile(
      entry,
      [
        "import { writeFileSync } from 'node:fs';",
        `import { z } from ${JSON.stringify(zodModule)};`,
        `writeFileSync(${JSON.stringify(sentinel)}, 'imported');`,
        'export const schema = z.object({ ANTHROPIC_API_KEY: z.string() });',
      ].join('\n'),
    );

    const staticallyGenerated = await generateTypes({ entry, static: true });
    expect(staticallyGenerated).toContain('anthropicApiKey');
    expect(await Bun.file(sentinel).exists()).toBe(false);

    await generateTypes({ entry });
    expect(await Bun.file(sentinel).exists()).toBe(true);
  });

  it('writes both declaration and module output that tsc accepts', async () => {
    const directory = await temporaryDirectory();
    const declarationDirectory = join(directory, 'declaration');
    const moduleDirectory = join(directory, 'module');
    const declaration = join(declarationDirectory, 'generated.d.ts');
    const module = join(moduleDirectory, 'generated.ts');
    expect(
      await main(['types', fixture, '--out', declaration, '--type-name', 'DeclarationEnvironment']),
    ).toBe(0);
    expect(
      await main(['types', fixture, '--out', module, '--type-name', 'ModuleEnvironment']),
    ).toBe(0);
    await writeFile(
      join(directory, 'consumer.ts'),
      [
        "import type { DeclarationEnvironment } from './declaration/generated';",
        "import type { ModuleEnvironment } from './module/generated';",
        'const declaration: DeclarationEnvironment = { mode: "dev", anthropicApiKey: "key", server: { port: 1, enabled: true } };',
        'const moduleValue: ModuleEnvironment = declaration;',
        'void moduleValue;',
      ].join('\n'),
    );
    await writeFile(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'ESNext',
          moduleResolution: 'Bundler',
          skipLibCheck: true,
        },
        include: ['**/*.ts', '**/*.d.ts'],
      }),
    );
    await runTsc(directory);
  });

  it('statically generates arrays, tuples, unions, records, literals, and special types', async () => {
    const directory = await temporaryDirectory();
    const entry = join(directory, 'static.ts');
    const zodModule = resolve('node_modules/zod/index.js');
    await writeFile(
      entry,
      [
        `import { z } from ${JSON.stringify(zodModule)};`,
        'export const schema = z.object({ TEXT: z.string(), COUNT: z.number(), ENABLED: z.boolean(), ITEMS: z.array(z.string()), PAIR: z.tuple([z.string(), z.number()]), VALUE: z.literal("value"), BIG_LITERAL: z.literal(1n), OPTIONAL: z.string().optional(), ANY: z.any(), UNKNOWN: z.unknown(), NEVER: z.never(), DATE: z.date(), UNION: z.union([z.string(), z.number()]), LOOKUP: z.record(z.string(), z.string()) });',
      ].join('\n'),
    );
    const generated = await generateTypes({ entry, static: true });
    expect(generated).toContain('Array<string>');
    expect(generated).toContain('[string, number]');
    expect(generated).toContain('"value"');
    expect(generated).toContain('Record<string, string>');
  });

  it('locates explicit exports, environmentalist calls, and SCHEMA-backed environments', async () => {
    const directory = await temporaryDirectory();
    const named = join(directory, 'named.ts');
    const zodModule = resolve('node_modules/zod/index.js');
    await writeFile(
      named,
      `import { z } from ${JSON.stringify(zodModule)};\nexport const custom = z.object({ CUSTOM_KEY: z.string() });\n`,
    );
    const explicit = await locateSchema(named, { exportName: 'custom' });
    expect(explicit.schema).toBeDefined();

    const call = join(directory, 'call.ts');
    await writeFile(
      call,
      [
        `import { z } from ${JSON.stringify(zodModule)};`,
        `import { environmentalist } from ${JSON.stringify(resolve('src/index.ts'))};`,
        "const schema = z.object({ CALL_KEY: z.string().default('yes') });",
        "export const environment = environmentalist({ name: 'call', schema, env: {}, argv: [] });",
      ].join('\n'),
    );
    const locatedCall = await locateSchema(call);
    expect(locatedCall.environment).toBeDefined();
    expect(findSchemaExpression(call).expression.getText()).toContain('environmentalist');
    const discovered = join(directory, 'discovered.ts');
    await writeFile(
      discovered,
      `import { z } from ${JSON.stringify(zodModule)};\nimport { environmentalist } from ${JSON.stringify(resolve('src/index.ts'))};\nconst value = environmentalist({ name: 'discovered', schema: z.object({ DISCOVERED: z.string() }), env: {}, argv: [] });\nvoid value;`,
    );
    expect(findSchemaExpression(discovered).expression.getText()).toContain('z.object');
    const backReference =
      locatedCall.environment === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(locatedCall.environment, SCHEMA)?.value;
    expect(backReference === locatedCall.schema).toBe(true);

    const options = join(directory, 'options.ts');
    await writeFile(
      options,
      `import { z } from ${JSON.stringify(zodModule)};\nexport default { schema: z.object({ VALUE: z.string() }) };\n`,
    );
    const locatedOptions = await locateSchema(options);
    expect(locatedOptions.schema).toBeDefined();

    const defaultSchema = join(directory, 'default.ts');
    await writeFile(
      defaultSchema,
      `import { z } from ${JSON.stringify(zodModule)};\nexport default z.object({ DEFAULT_KEY: z.string() });\n`,
    );
    const locatedDefault = await locateSchema(defaultSchema);
    expect(locatedDefault.schema).toBeDefined();

    const nonObject = join(directory, 'non-object.ts');
    await writeFile(
      nonObject,
      `import { z } from ${JSON.stringify(zodModule)};\nexport const schema = z.string();\n`,
    );
    const locatedNonObject = await locateSchema(nonObject);
    expect(() => requireObjectSchema(locatedNonObject.schema)).toThrow('Zod object');

    const primitive = join(directory, 'primitive.ts');
    await writeFile(primitive, 'export const value = 1;\n');
    expect(findSchemaExpression(primitive, { exportName: 'value' }).expression.getText()).toBe('1');

    const unsupportedCall = join(directory, 'unsupported-call.ts');
    await writeFile(
      unsupportedCall,
      `import { environmentalist } from ${JSON.stringify(resolve('src/index.ts'))};\nvoid environmentalist({ name: 'unsupported' });`,
    );
    expect(() => findSchemaExpression(unsupportedCall)).toThrow('Could not locate a schema');

    const exportEquals = join(directory, 'export-equals.ts');
    await writeFile(exportEquals, 'export = 1;\n');
    expect(() => findSchemaExpression(exportEquals)).toThrow('Could not locate a schema');
  });
});

describe('CLI commands', () => {
  it('runs schema, initialize, print, help, and unknown-command paths', async () => {
    const directory = await temporaryDirectory();
    const schemaOutput = join(directory, 'schema.json');
    expect(await main(['schema', fixture, '--out', schemaOutput])).toBe(0);
    const schemaContents = await readFile(schemaOutput, 'utf8');
    expect(JSON.parse(schemaContents).type).toBe('object');

    expect(
      await main([
        'initialize',
        fixture,
        '--name',
        'cli-app',
        '--format',
        'json',
        '--env-example',
        '--cwd',
        directory,
      ]),
    ).toBe(0);
    expect(await Bun.file(join(directory, 'cli-app.config.json')).exists()).toBe(true);
    expect(await readFile(join(directory, '.env.example'), 'utf8')).toContain('ANTHROPIC_API_KEY');

    const printEntry = join(directory, 'print.ts');
    await writeFile(
      printEntry,
      [
        `import { z } from ${JSON.stringify(resolve('node_modules/zod/index.js'))};`,
        "export const schema = z.object({ SECRET_KEY: z.string().default('do-not-print').meta({ secret: true }), MODE: z.string().default('test').meta({ description: 'Execution mode' }) });",
      ].join('\n'),
    );
    const printed = await capture(() => main(['print', printEntry]));
    expect(printed.code).toBe(0);
    expect(printed.output).toContain('REDACTED');
    expect(printed.output).not.toContain('do-not-print');
    expect(printed.output).toContain('Execution mode');
    const globalHelp = await capture(() => main(['--help']));
    expect(globalHelp.code).toBe(0);
    const unknown = await capture(() => main(['unknown']));
    expect(unknown.error).toContain('Unknown command');
  });

  it('supports command help and rejects unsupported generation flags clearly', async () => {
    const help = await capture(() => main(['types', '--help']));
    expect(help.code).toBe(0);
    expect(help.output).toContain('--static');
    const unsupported = await capture(() => main(['types', fixture, '--augment']));
    expect(unsupported.code).toBe(1);
    expect(unsupported.error).toContain('not implemented');
  });

  it('supports explicit type formats and rejects unsupported formats', async () => {
    const output = await generateTypes({ entry: fixture, format: 'TS', typeName: 'Generated' });
    expect(output).toContain('export type Generated');
    const directory = await temporaryDirectory();
    const target = join(directory, 'nested', 'types.ts');
    await generateTypes({ entry: fixture, out: target });
    expect(await Bun.file(target).exists()).toBe(true);
    await expectGenerateFailure({ entry: fixture, format: 'wat' }, 'Unsupported types format');
  });

  it('reports command usage, format, schema, and print failures', async () => {
    const directory = await temporaryDirectory();
    const bad = join(directory, 'bad.ts');
    await writeFile(bad, 'export const value = 1;');
    const typesMissing = await capture(() => main(['types']));
    expect(typesMissing.code).toBe(1);
    const schemaMissing = await capture(() => main(['schema']));
    expect(schemaMissing.code).toBe(1);
    const printMissing = await capture(() => main(['print']));
    expect(printMissing.code).toBe(1);
    const badSchema = await capture(() => main(['schema', bad]));
    expect(badSchema.code).toBe(1);
    const badFormat = await capture(() => main(['initialize', '--format', 'ini']));
    expect(badFormat.code).toBe(1);
    const noEntry = await capture(() => main(['initialize', '--cwd', directory]));
    expect(noEntry.code).toBe(0);
    expect(await Bun.file(join(directory, 'environment.config.ts')).exists()).toBe(true);
    const separator = await capture(() => main(['unknown', '--', 'ignored']));
    expect(separator.code).toBe(1);

    const schemaConsole = await capture(() => main(['schema', fixture]));
    expect(schemaConsole.code).toBe(0);
    expect(schemaConsole.output).toContain('"type"');

    const bigintEntry = join(directory, 'bigint.ts');
    await writeFile(
      bigintEntry,
      `import { z } from ${JSON.stringify(resolve('node_modules/zod/index.js'))};\nexport default { schema: z.object({ VALUE: z.any().default(1n) }), env: {}, argv: [] };`,
    );
    const bigintPrint = await capture(() => main(['print', bigintEntry]));
    expect(bigintPrint.error).toBe('');
    expect(bigintPrint.code).toBe(0);
    expect(bigintPrint.output).toContain('[object BigInt]');
  });

  it('runs the CLI module entrypoint success and error handlers', async () => {
    const originalArguments = process.argv;
    const originalExitCode = process.exitCode;
    const errors: string[] = [];
    const originalError = globalThis.console.error;
    globalThis.console.error = (message: unknown) => errors.push(String(message));
    try {
      process.argv = [process.argv[0] ?? 'bun', 'environmentalist', '--help'];
      await runCliEntrypoint();
      await runCliEntrypointIfMain('entrypoint', 'entrypoint');
      process.argv = [process.argv[0] ?? 'bun', 'environmentalist', 'unknown', '--invalid key'];
      await runCliEntrypoint();
      await runCliEntrypoint(async () => {
        throw new Error('entrypoint failure');
      });
    } finally {
      process.argv = originalArguments;
      process.exitCode = originalExitCode ?? 0;
      globalThis.console.error = originalError;
    }
    expect(errors.join('\n')).toContain('Invalid key');
    expect(errors.join('\n')).toContain('entrypoint failure');
  });
});

async function expectGenerateFailure(
  options: Parameters<typeof generateTypes>[0],
  message: string,
): Promise<void> {
  try {
    await generateTypes(options);
  } catch (error) {
    expect(error).toHaveProperty('message', expect.stringContaining(message));
  }
}
