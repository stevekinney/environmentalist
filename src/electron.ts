/* eslint-disable complexity */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';

import type { Source, SourceContext, SourceResult } from './types.js';
import { CONFIG_EXTENSIONS } from './sources/node/config-file.js';
import { normalizeRecord } from './sources/node/helpers.js';
import { createConfigLoader } from './sources/node/loader.js';
import { loadStructuredFile, loadStructuredFileSync } from './sources/node/parsers.js';

/** Inputs used to reproduce Electron's platform-specific application paths. */
export type ElectronPathOptions = {
  readonly platform?: NodeJS.Platform;
  readonly env?: Record<string, string | undefined>;
  readonly home?: string;
};

function platformJoin(platform: NodeJS.Platform, ...parts: string[]): string {
  return (platform === 'win32' ? win32 : posix).join(...parts);
}

/** Return Electron-compatible appData and userData paths without importing Electron. */
export function electronPaths(
  appName: string,
  options: ElectronPathOptions = {},
): { appData: string; userData: string } {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  let appData: string;

  switch (platform) {
    case 'darwin':
      appData = platformJoin(platform, home, 'Library', 'Application Support');
      break;
    case 'win32':
      appData = env['APPDATA'] ?? platformJoin(platform, home, 'AppData', 'Roaming');
      break;
    case 'linux':
      appData = env['XDG_CONFIG_HOME'] ?? platformJoin(platform, home, '.config');
      break;
    default:
      appData = env['XDG_CONFIG_HOME'] ?? platformJoin(platform, home, '.config');
      break;
  }

  return { appData, userData: platformJoin(platform, appData, appName) };
}

type UserDataOptions = {
  readonly userData?: string;
  readonly appName?: string;
};

function candidateFiles(directory: string, appName: string): string[] {
  const config = CONFIG_EXTENSIONS.map((extension) =>
    join(directory, `${appName}.config${extension}`),
  ).find((location) => existsSync(location));
  const candidates = config === undefined ? [] : [config];
  candidates.push(join(directory, 'config.json'), join(directory, `${appName}.json`));
  return candidates.filter((location) => existsSync(location));
}

function sourceDirectory(options: UserDataOptions, appName: string): string {
  return options.userData ?? electronPaths(appName).userData;
}

function mergeValues(values: readonly Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const value of values) {
    for (const [key, child] of Object.entries(value)) {
      if (!(key in merged)) merged[key] = child;
    }
  }
  return merged;
}

async function loadUserData(
  context: SourceContext,
  options: UserDataOptions,
): Promise<SourceResult | undefined> {
  const appName = options.appName ?? context.name;
  const locations = candidateFiles(sourceDirectory(options, appName), appName);
  if (locations.length === 0) return undefined;
  const loader = createConfigLoader();
  const values = await Promise.all(
    locations.map(async (location) => normalizeRecord(await loadStructuredFile(location, loader))),
  );
  const records = values.filter((value): value is Record<string, unknown> => value !== undefined);
  if (records.length === 0) return undefined;
  return { values: mergeValues(records), location: dirname(locations[0] ?? '') };
}

function loadUserDataSync(
  context: SourceContext,
  options: UserDataOptions,
): SourceResult | undefined {
  const appName = options.appName ?? context.name;
  const locations = candidateFiles(sourceDirectory(options, appName), appName);
  if (locations.length === 0) return undefined;
  const loader = createConfigLoader();
  const values = locations.map((location) =>
    normalizeRecord(loadStructuredFileSync(location, loader)),
  );
  const records = values.filter((value): value is Record<string, unknown> => value !== undefined);
  if (records.length === 0) return undefined;
  return { values: mergeValues(records), location: dirname(locations[0] ?? '') };
}

/** Create a typed source for Electron userData, electron-store, and app JSON files. */
export function createUserDataConfigSource(options: UserDataOptions = {}): Source {
  return {
    id: 'user-data',
    kind: 'typed',
    load: (context) => loadUserData(context, options),
    loadSync: (context) => loadUserDataSync(context, options),
  };
}
