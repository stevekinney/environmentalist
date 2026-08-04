import { tryCanonicalizeKey } from './keys.js';
import type { Source, SourceContext, SourceResult } from './types.js';

/** Options for the URL search-parameters source. */
export type SearchParamsSourceOptions = {
  readonly search?: string | URL | URLSearchParams;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addValue(target: Record<string, unknown>, key: string, value: string): void {
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

function getSearch(
  search: string | URL | URLSearchParams | undefined,
): { readonly parameters: URLSearchParams; readonly location: string } | undefined {
  if (search instanceof URL) {
    return { parameters: search.searchParams, location: search.toString() };
  }
  if (search instanceof URLSearchParams) {
    return { parameters: search, location: 'search-params' };
  }
  if (search !== undefined) {
    return {
      parameters: new URLSearchParams(search.startsWith('?') ? search.slice(1) : search),
      location: 'search-params',
    };
  }

  const browser = (
    globalThis as typeof globalThis & {
      window?: { location?: { search?: string } };
    }
  ).window;
  const query = browser?.location?.search;
  return query === undefined
    ? undefined
    : {
        parameters: new URLSearchParams(query),
        location: 'search-params',
      };
}

function loadSearchParams(
  context: SourceContext,
  options: SearchParamsSourceOptions,
): SourceResult | undefined {
  const input = getSearch(options.search);
  if (input === undefined) return undefined;

  const values: Record<string, unknown> = {};
  for (const [rawKey, value] of input.parameters) {
    const key = tryCanonicalizeKey(rawKey);
    if (key === undefined || context.secretKeys?.has(key)) continue;

    addValue(values, key, value);
  }

  return Object.keys(values).length === 0
    ? undefined
    : {
        values,
        location: input.location,
      };
}

/** Create a synchronous source that reads configuration from URL search parameters. */
export function createSearchParamsSource(options: SearchParamsSourceOptions = {}): Source {
  return {
    id: 'search-params',
    kind: 'string',
    load: (context) => loadSearchParams(context, options),
    loadSync: (context) => loadSearchParams(context, options),
  };
}
