import type { z } from 'zod';

import type { EnvironmentalistError } from './errors.js';

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

type IsUppercase<Character extends string> =
  Character extends Uppercase<Character>
    ? Character extends Lowercase<Character>
      ? false
      : true
    : false;

type IsLowercase<Character extends string> =
  Character extends Lowercase<Character>
    ? Character extends Uppercase<Character>
      ? false
      : true
    : false;

type IsDigit<Character extends string> = Character extends Digit ? true : false;

type StringToCharacters<
  Value extends string,
  Result extends string[] = [],
> = Value extends `${infer First}${infer Rest}`
  ? StringToCharacters<Rest, [...Result, First]>
  : Result;

type ShouldSplit<Previous extends string, Current extends string, Next extends string> =
  IsUppercase<Current> extends true
    ? IsLowercase<Previous> extends true
      ? true
      : IsDigit<Previous> extends true
        ? true
        : IsUppercase<Previous> extends true
          ? IsLowercase<Next>
          : false
    : false;

type SplitWords<
  Characters extends string[],
  Current extends string = '',
  Words extends string[] = [],
  Previous extends string = '',
> = Characters extends [
  infer Character extends string,
  infer Next extends string,
  ...infer Rest extends string[],
]
  ? Character extends '_' | '-'
    ? SplitWords<[Next, ...Rest], '', Current extends '' ? Words : [...Words, Current]>
    : ShouldSplit<Previous, Character, Next> extends true
      ? SplitWords<
          [Next, ...Rest],
          Character,
          Current extends '' ? Words : [...Words, Current],
          Character
        >
      : SplitWords<[Next, ...Rest], `${Current}${Character}`, Words, Character>
  : Characters extends [infer Character extends string]
    ? Character extends '_' | '-'
      ? Current extends ''
        ? Words
        : [...Words, Current]
      : [...Words, `${Current}${Character}`]
    : Current extends ''
      ? Words
      : [...Words, Current];

type LowercaseWord<Word extends string> = Lowercase<Word>;

type PascalCaseWord<Word extends string> = Word extends `${infer First}${infer Rest}`
  ? First extends Digit
    ? `_${First}${Lowercase<Rest>}`
    : `${Uppercase<First>}${Lowercase<Rest>}`
  : Word;

type JoinCamelWords<Words extends string[], Result extends string = ''> = Words extends [
  infer First extends string,
  ...infer Rest extends string[],
]
  ? JoinCamelWords<
      Rest,
      `${Result}${Result extends '' ? LowercaseWord<First> : PascalCaseWord<First>}`
    >
  : Result;

type CamelCaseSegment<Value extends string> = string extends Value
  ? string
  : JoinCamelWords<SplitWords<StringToCharacters<Value>>>;

/** The type-level equivalent of change-case v5's camelCase transform. */
export type CamelCase<Value extends string> = Value extends `${infer Head}.${infer Tail}`
  ? `${CamelCaseSegment<Head>}.${CamelCase<Tail>}`
  : CamelCaseSegment<Value>;

/**
 * Recursively camel-case object keys while preserving leaves and array shapes.
 */
export type CamelCasedPropertiesDeep<Value> = Value extends readonly unknown[]
  ? { [Key in keyof Value]: CamelCasedPropertiesDeep<Value[Key]> }
  : Value extends (...arguments_: never[]) => unknown
    ? Value
    : Value extends object
      ? {
          [
            Key in keyof Value as Key extends string ? CamelCase<Key> : Key
          ]: CamelCasedPropertiesDeep<Value[Key]>;
        }
      : Value;

/** Recursively make object properties optional while preserving array shapes. */
export type DeepPartial<Value> = Value extends readonly unknown[]
  ? { [Key in keyof Value]: DeepPartial<Value[Key]> }
  : Value extends (...arguments_: never[]) => unknown
    ? Value
    : Value extends object
      ? { [Key in keyof Value]?: DeepPartial<Value[Key]> }
      : Value;

/** Symbol containing the per-key winning source provenance map. */
export const SOURCES: unique symbol = Symbol('environmentalist.sources');

/** Symbol containing the Zod schema used to produce an environment. */
export const SCHEMA: unique symbol = Symbol('environmentalist.schema');

/** Built-in source identifiers shared by Node and browser adapters. */
export type SourceName =
  | 'flags'
  | 'search-params'
  | 'env'
  | 'dotenv'
  | 'project-config'
  | 'package-json'
  | 'user-dotfile'
  | 'xdg-config'
  | 'home-config'
  | 'defaults'
  | 'injected-global'
  | 'local-storage'
  | 'import-meta-env';

/** Context passed to every source loader. */
export type SourceContext = {
  readonly name: string;
  readonly cwd: string;
  readonly mode: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly envPrefix: string | undefined;
  /** Canonical keys marked `secret` in the schema; sources like search-params omit them. */
  readonly secretKeys?: ReadonlySet<string>;
};

/** A canonical-keyed partial result from a source. */
export type SourceResult = {
  readonly values: Record<string, unknown>;
  readonly location: string;
};

/** The common source loader contract. */
export type Source = {
  readonly id: SourceName | (string & {});
  readonly kind: 'string' | 'typed';
  readonly load: (
    context: SourceContext,
  ) => SourceResult | undefined | Promise<SourceResult | undefined>;
  /** Synchronous variant, when the source supports the sync resolution path. */
  readonly loadSync?: (context: SourceContext) => SourceResult | undefined;
};

/** A built-in source id or a custom source implementation. */
export type SourceSpec = SourceName | Source;

/** Provenance for a value that won a canonical key. */
export type Provenance = {
  readonly source: string;
  readonly location: string;
};

type CanonicalKey<S extends z.ZodObject> = keyof CamelCasedPropertiesDeep<z.output<S>> & string;

/** Per-key provenance map attached to a resolved environment. */
export type SourceMap<S extends z.ZodObject> = Partial<Record<CanonicalKey<S>, Provenance>>;

/** Per-key resolution details for the `onResolve` hook. */
export type ResolutionTrace = Readonly<
  Record<
    string,
    {
      readonly winning: Provenance | undefined;
      readonly considered: readonly Provenance[];
    }
  >
>;

/** Options accepted by dotenv-backed sources. */
export type DotenvOptions = Readonly<Record<string, unknown>>;

/** Loader seam for JavaScript/TypeScript project configuration files. */
export type ConfigLoader = (location: string) => unknown;

/** Options for resolving a schema-backed environment. */
export type EnvironmentalistOptions<S extends z.ZodObject> = {
  readonly name: string;
  readonly schema: S;
  readonly cwd?: string;
  readonly root?: string;
  readonly stopAt?: string | readonly string[];
  readonly modeKey?: CanonicalKey<S>;
  readonly envPrefix?: string;
  readonly env?: Record<string, string>;
  readonly argv?: readonly string[];
  readonly aliases?: Record<string, CanonicalKey<S>>;
  readonly search?: string | URL | URLSearchParams;
  readonly dotenv?: boolean | DotenvOptions;
  readonly coerce?: boolean;
  readonly loader?: 'auto' | 'bun' | 'jiti' | ConfigLoader;
  readonly sources?: readonly SourceSpec[];
  readonly exclude?: readonly SourceName[];
  readonly onResolve?: (trace: ResolutionTrace) => void;
};

/** The frozen, camelCase public environment for a schema. */
export type Environment<S extends z.ZodObject> = Readonly<CamelCasedPropertiesDeep<z.output<S>>> & {
  readonly [SOURCES]: SourceMap<S>;
  readonly [SCHEMA]: S;
};

/** Result shape for non-throwing resolution. */
export type SafeResult<S extends z.ZodObject> =
  | { readonly success: true; readonly data: Environment<S> }
  | { readonly success: false; readonly error: EnvironmentalistError };
