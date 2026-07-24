import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Source, SourceContext } from '../../types.js';

import { isRecord, normalizeRecord } from './helpers.js';
import type { NodeSourceOptions } from './options.js';
import { directoriesToWorkspaceRoot } from './workspace.js';

function loadPackage(context: SourceContext, options: NodeSourceOptions) {
  for (const directory of directoriesToWorkspaceRoot(context.cwd, options)) {
    const location = join(directory, 'package.json');
    if (!existsSync(location)) {
      continue;
    }
    try {
      const packageJson: unknown = JSON.parse(readFileSync(location, 'utf8'));
      if (!isRecord(packageJson)) {
        continue;
      }
      const values = normalizeRecord(packageJson[context.name]);
      if (values !== undefined) {
        return { values, location };
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Create a source that reads the named key from the nearest package manifest. */
export function createPackageJsonSource(options: NodeSourceOptions = {}): Source {
  return {
    id: 'package-json',
    kind: 'typed',
    load: (context) => loadPackage(context, options),
    loadSync: (context) => loadPackage(context, options),
  };
}

/** Alias for {@link createPackageJsonSource}. */
export const packageJsonSource = createPackageJsonSource;
