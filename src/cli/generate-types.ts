/* eslint-disable complexity */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { IndentationText, Project, TypeFormatFlags, VariableDeclarationKind } from 'ts-morph';
import type { SourceFile, Type } from 'ts-morph';

import { canonicalizeKey } from '../keys.js';
import { locateSchema, findSchemaExpression, nameFromEntry } from './locate-schema.js';
import type { TypeGenerationKind } from './zod-to-ts.js';
import { zodToType } from './zod-to-ts.js';

/** Options accepted by the `types` subcommand. */
export type GenerateTypesOptions = {
  readonly entry: string;
  readonly out?: string;
  readonly typeName?: string;
  readonly kind?: TypeGenerationKind;
  readonly exportName?: string;
  readonly format?: string;
  readonly cwd?: string;
  readonly static?: boolean;
};

function typeNameFor(entry: string, explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const name = canonicalizeKey(nameFromEntry(entry)).replace(/[^A-Za-z0-9_$]/gu, ' ');
  const pascal = name
    .split(/[^A-Za-z0-9_$]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
  return `${pascal || 'Environment'}Environment`;
}

function formatFor(options: GenerateTypesOptions): 'd.ts' | 'ts' {
  const format = options.format?.toLowerCase();
  if (format === 'ts') return 'ts';
  if (format === 'd.ts' || format === 'dts' || format === 'declaration') return 'd.ts';
  if (format !== undefined) throw new Error(`Unsupported types format "${options.format}".`);
  if (options.out?.endsWith('.ts') && !options.out.endsWith('.d.ts')) return 'ts';
  return 'd.ts';
}

function literalType(type: Type): string | undefined {
  if (!type.isLiteral()) return undefined;
  const value = type.getLiteralValue();
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value.toString();
  return undefined;
}

function primitiveType(type: Type): string | undefined {
  if (type.isString()) return 'string';
  if (type.isNumber()) return 'number';
  if (type.isBoolean()) return 'boolean';
  if (type.isBigInt()) return 'bigint';
  if (type.isNull()) return 'null';
  if (type.isUndefined()) return 'undefined';
  if (type.isAny() || type.isUnknown()) return 'unknown';
  if (type.isNever()) return 'never';
  return literalType(type);
}

function unionType(types: readonly string[]): string {
  return [...new Set(types)].join(' | ') || 'unknown';
}

function keyForType(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : JSON.stringify(key);
}

function staticTypeText(type: Type, sourceFile: SourceFile, seen: Set<Type>): string {
  if (seen.has(type)) return 'unknown';
  const primitive = primitiveType(type);
  if (primitive !== undefined) return primitive;
  if (type.isUnion()) {
    return unionType(
      type.getUnionTypes().map((member) => staticTypeText(member, sourceFile, new Set(seen))),
    );
  }
  if (type.isArray()) {
    return `Array<${staticTypeText(type.getArrayElementType() ?? type, sourceFile, new Set(seen))}>`;
  }
  if (type.isTuple()) {
    return `[${type
      .getTupleElements()
      .map((member) => staticTypeText(member, sourceFile, new Set(seen)))
      .join(', ')}]`;
  }

  const text = type.getText(sourceFile, TypeFormatFlags.NoTruncation);
  if (text === 'Date' || text.endsWith('.Date')) return 'Date';
  const indexType = type.getStringIndexType();
  if (indexType !== undefined) {
    return `Record<string, ${staticTypeText(indexType, sourceFile, new Set(seen))}>`;
  }

  const properties = type.getProperties();
  if (properties.length === 0) return text === 'object' ? 'Record<string, unknown>' : text;

  const named = properties.filter((property) => property.getName() !== '__proto__');
  const canonicalNames = named.map((property) => {
    try {
      return canonicalizeKey(property.getName());
    } catch {
      return undefined;
    }
  });
  if (canonicalNames.some((name) => name === undefined)) return text;

  const nextSeen = new Set(seen).add(type);
  const lines = named.map((property, index) => {
    const declaration = property.getDeclarations()[0];
    const propertyType = property.getTypeAtLocation(declaration ?? sourceFile);
    const name = canonicalNames[index] ?? property.getName();
    const marker = property.isOptional() ? '?' : '';
    return `  readonly ${keyForType(name)}${marker}: ${staticTypeText(propertyType, sourceFile, nextSeen)};`;
  });
  return lines.length === 0
    ? '{ }'
    : `{
${lines.join('\n')}
}`;
}

function staticType(
  entry: string,
  exportName: string | undefined,
  kind: TypeGenerationKind,
  cwd: string | undefined,
): string {
  const reference = findSchemaExpression(entry, {
    ...(exportName === undefined ? {} : { exportName }),
    ...(cwd === undefined ? {} : { cwd }),
  });
  const schemaName = '__environmentalistCliSchema';
  const typeName = '__environmentalistCliType';
  const initializer = reference.expression.getText();
  reference.sourceFile.addVariableStatement({
    declarationKind: VariableDeclarationKind.Const,
    declarations: [{ name: schemaName, initializer }],
  });
  const alias = reference.sourceFile.addTypeAlias({
    name: typeName,
    type: `import('zod').${kind}<typeof ${schemaName}>`,
  });
  return staticTypeText(alias.getType(), reference.sourceFile, new Set<Type>());
}

function authoredType(typeName: string, typeText: string, format: 'd.ts' | 'ts'): string {
  const project = new Project({
    useInMemoryFileSystem: true,
    manipulationSettings: { indentationText: IndentationText.TwoSpaces },
  });
  const sourceFile = project.createSourceFile(`/environmentalist-generated.${format}`, '');
  sourceFile.addTypeAlias({ name: typeName, isExported: true, type: typeText });
  sourceFile.formatText();
  return sourceFile.getFullText();
}

/** Generate a portable declaration or TypeScript type module from a schema entry. */
export async function generateTypes(options: GenerateTypesOptions): Promise<string> {
  const kind = options.kind ?? 'output';
  const format = formatFor(options);
  const typeName = typeNameFor(options.entry, options.typeName);
  let typeText: string;
  if (options.static) {
    typeText = staticType(options.entry, options.exportName, kind, options.cwd);
  } else {
    const located = await locateSchema(options.entry, {
      ...(options.exportName === undefined ? {} : { exportName: options.exportName }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    typeText = zodToType(located.schema, kind);
  }
  const output = authoredType(typeName, typeText, format);
  if (options.out === undefined) return output;
  const target = resolve(options.cwd ?? process.cwd(), options.out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, output, 'utf8');
  return output;
}

/** Reject design flags that would otherwise be silently ignored by this track. */
export function rejectUnsupportedTypesFlags(flags: Record<string, unknown>): void {
  if (flags['augment'] !== undefined) throw new Error('--augment is not implemented yet.');
  if (flags['watch'] !== undefined) throw new Error('--watch is not implemented yet.');
  if (flags['sources'] !== undefined) throw new Error('--sources is not implemented yet.');
}
