/* eslint-disable complexity, max-lines, typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion, typescript/no-unnecessary-type-parameters */

import { z } from 'zod';

import { EnvironmentalistError } from './errors.js';
import { canonicalizeKey } from './keys.js';
import { metadataFor, secretKeysOf } from './metadata.js';
import { MASKED, redactDeep } from './redact.js';
import { hasSchemaDefault } from './resolve-core.js';
import type { ResolvedRaw } from './resolve-core.js';
import { SCHEMA, SOURCES } from './types.js';
import type {
  CamelCasedPropertiesDeep,
  Environment,
  ResolutionTrace,
  SafeResult,
} from './types.js';

/** Re-export the canonical raw output handed from resolution to validation. */
export type { ResolvedRaw } from './resolve-core.js';

type ValidationResolvedRaw = Omit<ResolvedRaw, 'defaultsExcluded'> & {
  readonly defaultsExcluded?: ResolvedRaw['defaultsExcluded'];
};

type SchemaRecord = Record<string, unknown>;
type ValidationIssue = {
  readonly key: string;
  readonly issue: z.core.$ZodIssue;
  readonly metadata: ReturnType<typeof metadataFor>;
};

function isRecord(value: unknown): value is SchemaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function definition(schema: unknown): SchemaRecord | undefined {
  if (!isRecord(schema)) return undefined;
  const zod = schema['_zod'];
  if (isRecord(zod) && isRecord(zod['def'])) return zod['def'];
  if (isRecord(schema['def'])) return schema['def'];
  return isRecord(schema['_def']) ? schema['_def'] : undefined;
}

function unwrap(schema: unknown): unknown {
  let current = schema;
  const seen = new Set<unknown>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const def = definition(current);
    if (def === undefined) return current;
    const type = def['type'];
    if (
      (type === 'optional' || type === 'nullable' || type === 'default' || type === 'catch') &&
      def['innerType'] !== undefined
    ) {
      current = def['innerType'];
    } else {
      return current;
    }
  }
  return current;
}

function shapeOf(schema: unknown): Record<string, z.ZodType> | undefined {
  const def = definition(unwrap(schema));
  if (def?.['type'] !== 'object') return undefined;
  const shape = def['shape'];
  return typeof shape === 'object' && shape !== null
    ? (shape as Record<string, z.ZodType>)
    : undefined;
}

function mapInput(value: unknown, schema: unknown): unknown {
  if (!isRecord(value)) return value;
  const shape = shapeOf(schema);
  if (shape === undefined) return { ...value };

  const result: Record<string, unknown> = {};
  const consumed = new Set<string>();
  for (const [originalKey, field] of Object.entries(shape)) {
    const canonicalKey = canonicalizeKey(originalKey);
    if (Object.hasOwn(value, canonicalKey)) {
      result[originalKey] = mapInput(value[canonicalKey], field);
      consumed.add(canonicalKey);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (!consumed.has(key)) result[key] = child;
  }
  return result;
}

function mapOutput(value: unknown, schema: unknown): unknown {
  if (!isRecord(value)) return value;
  const shape = shapeOf(schema);
  if (shape === undefined) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) result[canonicalizeKey(key)] = child;
    return result;
  }

  const result: Record<string, unknown> = {};
  const known = new Set<string>();
  for (const [originalKey, field] of Object.entries(shape)) {
    if (Object.hasOwn(value, originalKey)) {
      result[canonicalizeKey(originalKey)] = mapOutput(value[originalKey], field);
      known.add(originalKey);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (!known.has(key)) result[canonicalizeKey(key)] = child;
  }
  return result;
}

function removeDefaults(schema: unknown): unknown {
  const def = definition(schema);
  const type = def?.['type'];
  if (type === 'default' && def?.['innerType'] !== undefined) {
    return removeDefaults(def['innerType']);
  }
  if (
    (type === 'optional' || type === 'nullable' || type === 'catch') &&
    def?.['innerType'] !== undefined
  ) {
    const inner = removeDefaults(def['innerType']);
    if (inner === def['innerType']) return schema;
    if (type === 'optional') return (inner as z.ZodType).optional();
    if (type === 'nullable') return (inner as z.ZodType).nullable();
    return (inner as z.ZodType).catch(def['catchValue'] as never);
  }
  const shape = shapeOf(schema);
  if (shape === undefined) return schema;
  const nextShape: Record<string, z.ZodType> = {};
  let changed = false;
  for (const [key, field] of Object.entries(shape)) {
    const next = removeDefaults(field) as z.ZodType;
    nextShape[key] = next;
    changed ||= next !== field;
  }
  if (!changed) return schema;
  return (schema as z.ZodObject).extend(nextShape as never);
}

function formatValue(value: unknown, secret: boolean): string {
  if (secret) return MASKED;
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function issueKey(issue: z.core.$ZodIssue): string {
  return issue.path.length === 0 ? '(root)' : issue.path.map(String).map(canonicalizeKey).join('.');
}

function valueAtPath(
  values: Record<string, unknown>,
  key: string,
): { present: boolean; value: unknown } {
  let current: unknown = values;
  for (const segment of key.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, segment))
      return { present: false, value: undefined };
    current = current[segment];
  }
  return { present: true, value: current };
}

function issueSummary(
  issue: z.core.$ZodIssue,
  value: unknown,
  secret: boolean,
  missing: boolean,
): string {
  const record = issue as z.core.$ZodIssue & { expected?: string; input?: unknown };
  // An absent value fails differently per field type — an enum reports
  // invalid_value, not invalid_type — but it is the same problem either way.
  if (missing) return 'required, but not found';
  if (record.code === 'invalid_type' && record.expected !== undefined) {
    return `expected ${record.expected}, received ${formatValue(value, secret)}`;
  }
  return issue.message;
}

function fieldAtPath(schema: z.ZodObject, key: string): z.ZodType | undefined {
  let current: unknown = schema;
  for (const segment of key.split('.')) {
    const shape = shapeOf(current);
    if (shape === undefined) return undefined;
    const entry = Object.entries(shape).find(([original]) => canonicalizeKey(original) === segment);
    if (entry === undefined) return undefined;
    current = entry[1];
  }
  return current as z.ZodType;
}

function checkedFix(key: string, checked: readonly string[] | undefined, name: string): string {
  const env = checked?.find((entry) => entry.startsWith('env '))?.slice(4);
  const flag = checked?.find((entry) => entry.startsWith('flag '))?.slice(5);
  const suggestions: string[] = [];
  if (env !== undefined) suggestions.push(`export ${env}=…`);
  if (flag !== undefined) suggestions.push(`pass ${flag}=…`);
  suggestions.push(`add ${key} to ${name}.config.ts`);
  return suggestions.join(', or ');
}

function errorFor<S extends z.ZodObject>(
  name: string,
  schema: S,
  resolved: ValidationResolvedRaw,
  issues: readonly z.core.$ZodIssue[],
): EnvironmentalistError {
  const secretKeys = secretKeysOf(schema);
  const structured: ValidationIssue[] = issues.map((issue) => {
    const key = issueKey(issue);
    return {
      key,
      issue,
      metadata: fieldAtPath(schema, key) ? metadataFor(fieldAtPath(schema, key) as z.ZodType) : {},
    };
  });
  const lines = [
    `✖ Environmentalist could not resolve configuration for "${name}" (${issues.length} problems)`,
  ];
  for (const entry of structured) {
    const secret = secretKeys.has(entry.key);
    const resolvedValue = valueAtPath(resolved.values, entry.key);
    const value = resolvedValue.value;
    const missing = !resolvedValue.present || value === undefined;
    lines.push(`  ${entry.key} — ${issueSummary(entry.issue, value, secret, missing)}`);
    if (entry.metadata.description !== undefined) lines.push(`    ${entry.metadata.description}`);
    if (entry.metadata.example !== undefined)
      lines.push(`    Example: ${formatValue(entry.metadata.example, secret)}`);
    if (missing) {
      lines.push(`    Checked:  ${(resolved.checked[entry.key] ?? []).join(' · ')}`);
      if (resolved.defaultsExcluded === true && hasSchemaDefault(schema, entry.key)) {
        lines.push(
          `    Note:     this field declares a schema default, but the "defaults" source is not in the active chain — add "defaults" to sources, or drop it from exclude.`,
        );
      }
    } else {
      const source = resolved.provenance[entry.key];
      const sourceText =
        source === undefined ? 'unknown source' : `${source.source} ${source.location}`;
      lines.push(`    Source:   ${sourceText} (= ${formatValue(value, secret)})`);
      lines.push(`    Checked:  ${(resolved.checked[entry.key] ?? []).join(' · ')}`);
    }
    lines.push(`    Fix:      ${checkedFix(entry.key, resolved.checked[entry.key], name)}`);
    if (entry.metadata.docs !== undefined) lines.push(`    Docs:     ${entry.metadata.docs}`);
  }
  return new EnvironmentalistError(lines.join('\n'), structured);
}

/**
 * Deep-freeze a value, descending only through its own enumerable string keys.
 *
 * The environment carries the caller's schema on a non-enumerable symbol, and
 * the caller owns that object. Zod v4 materializes instance methods through
 * lazy getters that `defineProperty` on first access, so freezing the schema
 * breaks every method nobody happened to touch before resolution.
 */
function freezeDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const child of value) freezeDeep(child);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const child of Object.keys(value)) freezeDeep(value[child]);
    return Object.freeze(value);
  }
  return value;
}

function buildEnvironment<S extends z.ZodObject>(
  schema: S,
  parsed: unknown,
  resolved: ValidationResolvedRaw,
): Environment<S> {
  const secretKeys = secretKeysOf(schema);
  const environment = mapOutput(parsed, schema) as Environment<S> & Record<PropertyKey, unknown>;
  Object.defineProperty(environment, SOURCES, {
    value: freezeDeep(resolved.provenance),
    enumerable: false,
  });
  Object.defineProperty(environment, SCHEMA, { value: schema, enumerable: false });
  Object.defineProperty(environment, 'toJSON', {
    value: () => redactDeep(environment, secretKeys),
    enumerable: false,
  });
  Object.defineProperty(environment, Symbol.for('nodejs.util.inspect.custom'), {
    value: () => redactDeep(environment, secretKeys),
    enumerable: false,
  });
  return freezeDeep(environment);
}

/** Validate canonical resolved values and return a frozen canonical environment. */
export function validateResolved<S extends z.ZodObject>(input: {
  readonly name: string;
  readonly schema: S;
  readonly resolved: ValidationResolvedRaw;
}): Environment<S> {
  const result = safeValidateResolved(input);
  if (!result.success) throw result.error;
  return result.data;
}

/** Validate canonical resolved values without throwing on Zod failures. */
export function safeValidateResolved<S extends z.ZodObject>(input: {
  readonly name: string;
  readonly schema: S;
  readonly resolved: ValidationResolvedRaw;
}): SafeResult<S> {
  const { name, schema, resolved } = input;
  traceResolution({ name, trace: resolved.trace, secretKeys: secretKeysOf(schema) });
  const parseSchema = resolved.defaultsExcluded ? (removeDefaults(schema) as S) : schema;
  const parsed = parseSchema.safeParse(mapInput(resolved.values, schema));
  if (!parsed.success)
    return { success: false, error: errorFor(name, schema, resolved, parsed.error.issues) };
  return { success: true, data: buildEnvironment(schema, parsed.data, resolved) };
}

function omitSecrets(value: unknown, path: string, secretKeys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => omitSecrets(item, path, secretKeys));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    if (secretKeys.has(childPath)) continue;
    result[key] = omitSecrets(child, childPath, secretKeys);
  }
  return result;
}

/** Return a frozen, symbol-free copy suitable for crossing a public boundary. */
export function toPublic<S extends z.ZodObject>(
  environment: Environment<S>,
): Readonly<Partial<CamelCasedPropertiesDeep<z.output<S>>>> {
  const schema = environment[SCHEMA];
  return freezeDeep(omitSecrets(environment, '', secretKeysOf(schema))) as unknown as Readonly<
    Partial<CamelCasedPropertiesDeep<z.output<S>>>
  >;
}

/** Print a source-resolution table when Environmentalist debugging is enabled. */
export function traceResolution(input: {
  readonly name: string;
  readonly trace: ResolutionTrace;
  readonly secretKeys: ReadonlySet<string>;
  readonly writer?: (message: string) => void;
}): void {
  const debug =
    typeof process !== 'undefined' && process.env?.['DEBUG']?.includes('environmentalist');
  if (!debug && input.writer === undefined) return;
  const writer = input.writer ?? ((message: string) => globalThis.console.error(message));
  const lines = [`Environmentalist resolution for "${input.name}"`, 'Key | Winning | Considered'];
  for (const [key, detail] of Object.entries(input.trace)) {
    const winning =
      detail.winning === undefined ? 'none' : `${detail.winning.source} ${detail.winning.location}`;
    const considered = detail.considered
      .map(({ source, location }) => `${source} ${location}`)
      .join(' · ');
    lines.push(`${key} | ${winning} | ${considered}`);
  }
  writer(lines.join('\n'));
}
