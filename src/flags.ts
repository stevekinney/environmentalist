import { EnvironmentalistError } from './errors.js';
import { canonicalizeKey } from './keys.js';
import type { Source } from './types.js';

/** Options for parsing command-line flags. */
export type FlagOptions = {
  readonly aliases?: Record<string, string>;
  readonly flagOverrides?: Record<string, string>;
};

type FlagValue = string | boolean;

type ParsedFlag = {
  readonly key: string;
  readonly value: FlagValue;
  readonly consumesNext: boolean;
};

function flagName(value: string): string {
  return value.replace(/^-+/, '');
}

function canonicalFlagNames(options: FlagOptions): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const [alias, target] of Object.entries(options.aliases ?? {})) {
    aliases.set(flagName(alias), canonicalizeKey(target));
  }
  for (const [spelling, target] of Object.entries(options.flagOverrides ?? {})) {
    aliases.set(flagName(spelling), canonicalizeKey(target));
  }

  return aliases;
}

function canonicalFlagName(name: string, aliases: Map<string, string>): string {
  return aliases.get(name) ?? canonicalizeKey(name);
}

function isNegatedFlag(isLong: boolean, name: string): boolean {
  if (!isLong) return false;
  return name.startsWith('no-');
}

function valueForFlag(
  key: string,
  body: string,
  equalsIndex: number,
  next: string | undefined,
): ParsedFlag {
  if (equalsIndex !== -1) {
    return { key, value: body.slice(equalsIndex + 1), consumesNext: false };
  }
  if (next !== undefined && !next.startsWith('-')) {
    return { key, value: next, consumesNext: true };
  }
  return { key, value: true, consumesNext: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addValue(target: Record<string, unknown>, key: string, value: FlagValue): void {
  const segments = key.split('.');
  let current = target;

  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    const next = isRecord(child) ? child : {};

    current[segment] = next;
    current = next;
  }

  const leaf = segments.at(-1) ?? key;
  const existing = current[leaf];
  current[leaf] =
    existing === undefined
      ? value
      : Array.isArray(existing)
        ? [...existing, value]
        : [existing, value];
}

function parseArgument(
  argument: string,
  next: string | undefined,
  aliases: Map<string, string>,
): ParsedFlag | undefined {
  if (!argument.startsWith('-') || argument === '-') return undefined;

  const isLong = argument.startsWith('--');
  const body = argument.slice(isLong ? 2 : 1);
  if (body.length === 0) return undefined;

  const equalsIndex = body.indexOf('=');
  const rawName = equalsIndex === -1 ? body : body.slice(0, equalsIndex);
  const negated = isNegatedFlag(isLong, rawName);
  const name = negated ? rawName.slice(3) : rawName;
  const key = canonicalFlagName(name, aliases);

  if (negated) return { key, value: false, consumesNext: false };
  return valueForFlag(key, body, equalsIndex, next);
}

type ParsedArgv = {
  readonly values: Record<string, unknown>;
  readonly positionals: readonly string[];
};

function parseArgv(argv: readonly string[], options: FlagOptions): ParsedArgv {
  const values: Record<string, unknown> = {};
  const positionals: string[] = [];
  const aliases = canonicalFlagNames(options);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    const parsed = parseArgument(argument, argv[index + 1], aliases);
    if (parsed === undefined) {
      positionals.push(argument);
      continue;
    }
    addValue(values, parsed.key, parsed.value);
    if (parsed.consumesNext) index += 1;
  }

  return { values, positionals };
}

/** Parse argv into canonical, nested configuration values. */
export function parseFlags(
  argv: readonly string[],
  options: FlagOptions = {},
): Record<string, unknown> {
  return parseArgv(argv, options).values;
}

/**
 * Collect the non-flag arguments from argv—everything that isn't consumed as
 * a flag name or a flag's value, plus everything after a bare `--` terminator.
 */
export function parsePositionals(
  argv: readonly string[],
  options: FlagOptions = {},
): readonly string[] {
  return parseArgv(argv, options).positionals;
}

/** Describes one expected positional argument, in argv order. */
export type PositionalSpec = {
  readonly name: string;
  readonly description?: string;
  /** Defaults to `true`, except for a variadic entry, which defaults to `false`. */
  readonly required?: boolean;
  /** Consumes every remaining positional. Only the last entry in a spec may be variadic. */
  readonly variadic?: boolean;
};

function assertValidPositionalSpec(spec: readonly PositionalSpec[]): void {
  spec.forEach((entry, index) => {
    if (entry.variadic && index !== spec.length - 1) {
      throw new EnvironmentalistError(
        `Invalid positional spec: "${entry.name}" is variadic but is not the last entry.`,
      );
    }
    const previous = spec[index - 1];
    if (previous?.required === false && (entry.required ?? !entry.variadic)) {
      throw new EnvironmentalistError(
        `Invalid positional spec: required "${entry.name}" follows optional "${previous.name}".`,
      );
    }
  });
}

/**
 * Match parsed positionals against a spec, by argv order.
 *
 * @throws {@link EnvironmentalistError} when a required positional is missing,
 * an extra positional has no matching spec entry, or the spec itself is
 * malformed (a non-trailing variadic entry, or a required entry after an
 * optional one).
 */
export function matchPositionals(
  positionals: readonly string[],
  spec: readonly PositionalSpec[],
): Record<string, string | readonly string[]> {
  assertValidPositionalSpec(spec);
  const result: Record<string, string | readonly string[]> = {};
  let index = 0;

  for (const entry of spec) {
    const required = entry.required ?? !entry.variadic;
    if (entry.variadic) {
      const rest = positionals.slice(index);
      if (required && rest.length === 0) {
        throw new EnvironmentalistError(`Missing required positional argument "${entry.name}".`);
      }
      result[entry.name] = rest;
      index = positionals.length;
      continue;
    }

    const value = positionals[index];
    if (value === undefined) {
      if (required) {
        throw new EnvironmentalistError(`Missing required positional argument "${entry.name}".`);
      }
      continue;
    }
    result[entry.name] = value;
    index += 1;
  }

  if (index < positionals.length) {
    throw new EnvironmentalistError(
      `Unexpected positional argument "${positionals[index]}"; only ${spec.length} positional argument${spec.length === 1 ? '' : 's'} accepted.`,
    );
  }

  return result;
}

/** Options for the command-line source factory. */
export type FlagsSourceOptions = FlagOptions & {
  readonly argv?: readonly string[];
};

/** Create a source that reads canonical configuration values from argv. */
export function createFlagsSource(options: FlagsSourceOptions = {}): Source {
  const load = (context: Parameters<NonNullable<Source['loadSync']>>[0]) => ({
    values: parseFlags(options.argv ?? context.argv, options),
    location: 'argv',
  });

  return {
    id: 'flags',
    kind: 'string',
    load,
    loadSync: load,
  };
}
