/* eslint-disable typescript/no-unsafe-type-assertion */

import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

import { Node, Project, SyntaxKind } from 'ts-morph';
import type { CallExpression, Expression, SourceFile } from 'ts-morph';
import type { z } from 'zod';

import { SCHEMA } from '../types.js';
import { createConfigLoader } from '../sources/node/loader.js';

type SchemaOptions = Record<string, unknown> & { readonly schema: z.ZodType };

/** A schema and the optional runtime values found while loading an entry module. */
export type LocatedSchema = {
  readonly schema: z.ZodType;
  readonly options?: SchemaOptions;
  readonly environment?: unknown;
};

/** A schema expression found without executing the target module. */
export type StaticSchemaReference = {
  readonly expression: Expression;
  readonly sourceFile: SourceFile;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSchema(value: unknown): value is z.ZodType {
  if (!isRecord(value)) return false;
  const zod = value['_zod'];
  if (!isRecord(zod)) return false;
  const definition = zod['def'];
  return isRecord(definition) && typeof definition['type'] === 'string';
}

function isEnvironment(value: unknown): value is Record<PropertyKey, unknown> {
  if (!isRecord(value)) return false;
  const schema = (value as Record<PropertyKey, unknown>)[SCHEMA];
  return isSchema(schema);
}

function isSchemaOptions(value: unknown): value is SchemaOptions {
  return isRecord(value) && isSchema(value['schema']);
}

function schemaDefinition(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const zod = value['_zod'];
  if (!isRecord(zod)) return undefined;
  return isRecord(zod['def']) ? zod['def'] : undefined;
}

async function settled(value: unknown): Promise<unknown> {
  return value instanceof Promise ? value : Promise.resolve(value);
}

function candidateFromValue(value: unknown): LocatedSchema | undefined {
  if (isSchema(value)) return { schema: value };
  if (isEnvironment(value)) return { schema: value[SCHEMA] as z.ZodType, environment: value };
  if (isSchemaOptions(value)) return { schema: value.schema, options: value };
  return undefined;
}

function moduleExport(moduleValue: unknown, name: string): unknown {
  if (name === 'default') {
    return isRecord(moduleValue) && 'default' in moduleValue ? moduleValue['default'] : moduleValue;
  }
  return isRecord(moduleValue) ? moduleValue[name] : undefined;
}

function projectFor(entry: string): { project: Project; sourceFile: SourceFile } {
  let directory = dirname(entry);
  let tsconfig = resolve(directory, 'tsconfig.json');
  while (!existsSync(tsconfig) && directory !== dirname(directory)) {
    directory = dirname(directory);
    tsconfig = resolve(directory, 'tsconfig.json');
  }

  const project = existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig })
    : new Project({
        compilerOptions: {
          allowJs: false,
          baseUrl: process.cwd(),
          module: 99,
          moduleResolution: 100,
          paths: { zod: [resolve(process.cwd(), 'node_modules/zod/index.d.cts')] },
          target: 99,
          strict: true,
        },
      });
  const sourceFile = project.getSourceFile(entry) ?? project.addSourceFileAtPath(entry);
  return { project, sourceFile };
}

function schemaProperty(call: CallExpression): Expression | undefined {
  const argument = call.getArguments()[0];
  if (!Node.isObjectLiteralExpression(argument)) return undefined;
  const property = argument.getProperty('schema');
  return Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
}

function environmentalistSchemaCall(sourceFile: SourceFile): StaticSchemaReference | undefined {
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (expression.getText() !== 'environmentalist') continue;
    const schema = schemaProperty(call);
    if (schema !== undefined) return { expression: schema, sourceFile };
  }
  return undefined;
}

function declarationExpression(sourceFile: SourceFile, name: string): Expression | undefined {
  const declaration = sourceFile.getVariableDeclaration(name);
  if (declaration !== undefined) {
    const initializer = declaration.getInitializer();
    if (Node.isCallExpression(initializer)) return schemaProperty(initializer) ?? initializer;
    return initializer;
  }
  if (name !== 'default') return undefined;
  return sourceFile
    .getExportAssignments()
    .find((assignment) => !assignment.isExportEquals())
    ?.getExpression();
}

/** Find the schema expression in a source file for static type extraction. */
export function findSchemaExpression(
  entry: string,
  options: { readonly exportName?: string; readonly cwd?: string } = {},
): StaticSchemaReference {
  const location = resolve(options.cwd ?? process.cwd(), entry);
  const { sourceFile } = projectFor(location);
  const names =
    options.exportName === undefined ? ['environment', 'schema', 'default'] : [options.exportName];
  for (const name of names) {
    const expression = declarationExpression(sourceFile, name);
    if (expression !== undefined) return { expression, sourceFile };
  }
  const discovered = environmentalistSchemaCall(sourceFile);
  if (discovered !== undefined) return discovered;
  throw new Error(
    `Could not locate a schema in ${location}. Export a Zod schema, export environmentalist options, or use environmentalist({ schema: ... }).`,
  );
}

/** Load an entry module and locate a Zod schema, environment, or options object. */
export async function locateSchema(
  entry: string,
  options: { readonly exportName?: string; readonly cwd?: string } = {},
): Promise<LocatedSchema> {
  const location = resolve(options.cwd ?? process.cwd(), entry);
  const moduleValue = await createConfigLoader().load(location);
  const names =
    options.exportName === undefined ? ['environment', 'schema', 'default'] : [options.exportName];
  for (const name of names) {
    const candidate = candidateFromValue(await settled(moduleExport(moduleValue, name)));
    if (candidate !== undefined) return candidate;
  }
  const direct = candidateFromValue(await settled(moduleValue));
  if (direct !== undefined) return direct;

  let help = 'No supported schema export was found.';
  try {
    const reference = findSchemaExpression(
      location,
      options.exportName === undefined ? {} : { exportName: options.exportName },
    );
    help = `Found an environmentalist schema expression (${reference.expression.getText()}) but it could not be evaluated at runtime.`;
  } catch (error) {
    if (error instanceof Error) help = `${help} ${error.message}`;
  }
  throw new Error(`${help} Entry: ${location}`);
}

/** Derive a stable application name from a CLI entry path. */
export function nameFromEntry(entry: string): string {
  const base = entry.replaceAll('\\', '/').split('/').at(-1) ?? 'environment';
  return base.replace(/\.config(?=\.[^.]+$)/u, '').replace(extname(base), '') || 'environment';
}

/** Return a schema object or explain why a located schema cannot resolve an environment. */
export function requireObjectSchema(schema: z.ZodType): z.ZodObject {
  if (schemaDefinition(schema)?.['type'] === 'object') return schema as z.ZodObject;
  throw new Error('The located schema must be a Zod object for this subcommand.');
}
