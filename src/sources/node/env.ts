import { constantCase } from 'change-case';

import { toEnvName } from '../../keys.js';
import type { Source, SourceContext, SourceResult } from '../../types.js';

import { normalizeFlatEntries } from './helpers.js';

/** Options for the environment source factory. */
export type EnvSourceOptions = {
  readonly envPrefix?: string;
};

/** Return the environment-variable spelling for a canonical key. */
export function envNameFor(canonicalKey: string, prefix?: string): string {
  return toEnvName(canonicalKey, prefix);
}

function loadEnvironment(
  context: SourceContext,
  options: EnvSourceOptions,
): SourceResult | undefined {
  const prefix = options.envPrefix ?? context.envPrefix;
  const prefixName =
    prefix === undefined || prefix.length === 0 ? undefined : `${constantCase(prefix)}_`;
  const entries: Array<readonly [string, string]> = [];

  for (const [name, value] of Object.entries(context.env)) {
    if (!claimsEnvironmentName(name, value, prefixName)) {
      continue;
    }
    const key = prefixName === undefined ? name : name.slice(prefixName.length);
    if (key.length > 0) {
      entries.push([key.replaceAll('__', '.'), value]);
    }
  }

  if (entries.length === 0) {
    return undefined;
  }

  const values = normalizeFlatEntries(entries);

  return Object.keys(values).length === 0 ? undefined : { values, location: 'process.env' };
}

function claimsEnvironmentName(
  name: string,
  value: string | undefined,
  prefixName: string | undefined,
): value is string {
  return value !== undefined && (prefixName === undefined || name.startsWith(prefixName));
}

/** Create a source that claims all matching variables from the supplied environment. */
export function createEnvSource(options: EnvSourceOptions = {}): Source {
  return {
    id: 'env',
    kind: 'string',
    load: (context) => loadEnvironment(context, options),
    loadSync: (context) => loadEnvironment(context, options),
  };
}

/** Alias for {@link createEnvSource}. */
export const envSource = createEnvSource;
