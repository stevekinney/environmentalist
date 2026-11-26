import { canonicalizeKey, toEnvName } from './keys.js';
import { metadataFor } from './metadata.js';
import { schemaShape } from './resolve-core.js';
import type { z } from 'zod';
import type { Source, SourceResult } from './types.js';

/** A caller-supplied environment record, such as a Worker binding object. */
export type EnvironmentRecord = object;

/** Options for a source that reads only the schema's top-level environment names. */
export type EnvironmentRecordSourceOptions<S extends z.ZodObject> = {
  readonly schema: S;
  readonly environment?: EnvironmentRecord;
};

function fallbackEnvironment(): EnvironmentRecord {
  const runtimeProcess = Reflect.get(globalThis, 'process');
  if (typeof runtimeProcess !== 'object' || runtimeProcess === null) return {};

  const environment = Reflect.get(runtimeProcess, 'env');
  return typeof environment === 'object' && environment !== null ? environment : {};
}

function environmentValue(environment: EnvironmentRecord, name: string): string | undefined {
  const value = Reflect.get(environment, name);
  return typeof value === 'string' ? value : undefined;
}

function loadEnvironmentRecord<S extends z.ZodObject>(
  options: EnvironmentRecordSourceOptions<S>,
): SourceResult | undefined {
  const environment = options.environment ?? fallbackEnvironment();
  const values: Record<string, string> = {};

  for (const [key, field] of Object.entries(schemaShape(options.schema) ?? {})) {
    const canonicalKey = canonicalizeKey(key);
    const name = metadataFor(field).env ?? toEnvName(canonicalKey);
    const value = environmentValue(environment, name);
    if (value !== undefined) values[canonicalKey] = value;
  }

  return Object.keys(values).length === 0 ? undefined : { values, location: 'environment record' };
}

/**
 * Create a filesystem-free source that reads only the environment names declared by a schema.
 *
 * A caller can pass a Worker binding record through `environment`. Without one, the source reads
 * `process.env` when the global exists and otherwise returns no values.
 */
export function createEnvironmentRecordSource<S extends z.ZodObject>(
  options: EnvironmentRecordSourceOptions<S>,
): Source {
  const load = () => loadEnvironmentRecord(options);
  return { id: 'environment-record', kind: 'string', load, loadSync: load };
}
