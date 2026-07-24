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

/** Parse argv into canonical, nested configuration values. */
export function parseFlags(
  argv: readonly string[],
  options: FlagOptions = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const aliases = canonicalFlagNames(options);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--') break;
    const parsed = parseArgument(argument, argv[index + 1], aliases);
    if (parsed === undefined) continue;
    addValue(result, parsed.key, parsed.value);
    if (parsed.consumesNext) index += 1;
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
