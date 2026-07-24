import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

import type { Source, SourceContext } from '../../types.js';

import { CONFIG_EXTENSIONS } from './config-file.js';
import { normalizeRecord } from './helpers.js';
import { createConfigLoader } from './loader.js';
import { parseUserDotfile, loadStructuredFile, loadStructuredFileSync } from './parsers.js';
import type { NodeSourceOptions } from './options.js';

function homeDirectory(options: NodeSourceOptions): string {
  return options.home ?? options.homeDirectory ?? homedir();
}

function result(
  values: unknown,
  location: string,
): { values: Record<string, unknown>; location: string } | undefined {
  const normalized = normalizeRecord(values);
  return normalized === undefined ? undefined : { values: normalized, location };
}

async function loadDotfile(context: SourceContext, options: NodeSourceOptions) {
  const location = join(homeDirectory(options), `.${context.name}`);
  if (!existsSync(location)) {
    return undefined;
  }
  return result(parseUserDotfile(await readFile(location, 'utf8')), location);
}

function loadDotfileSync(context: SourceContext, options: NodeSourceOptions) {
  const location = join(homeDirectory(options), `.${context.name}`);
  if (!existsSync(location)) {
    return undefined;
  }
  return result(parseUserDotfile(readFileSync(location, 'utf8')), location);
}

function findXdgFile(context: SourceContext, options: NodeSourceOptions): string | undefined {
  const base = context.env['XDG_CONFIG_HOME'] ?? join(homeDirectory(options), '.config');
  return CONFIG_EXTENSIONS.map((extension) => join(base, context.name, `config${extension}`)).find(
    (location) => existsSync(location),
  );
}

async function loadXdg(context: SourceContext, options: NodeSourceOptions) {
  const location = findXdgFile(context, options);
  if (location === undefined) {
    return undefined;
  }
  const loader = createConfigLoader(options.loader);
  return result(await loadStructuredFile(location, loader), location);
}

function loadXdgSync(context: SourceContext, options: NodeSourceOptions) {
  const location = findXdgFile(context, options);
  if (location === undefined) {
    return undefined;
  }
  const loader = createConfigLoader(options.loader);
  return result(loadStructuredFileSync(location, loader), location);
}

function findHomeConfigFile(
  context: SourceContext,
  options: NodeSourceOptions,
): string | undefined {
  const directory = join(homeDirectory(options), '.environmentalist');
  const extensionless = join(directory, context.name);
  if (existsSync(extensionless)) {
    return extensionless;
  }
  const regular = CONFIG_EXTENSIONS.map((extension) =>
    join(directory, `${context.name}${extension}`),
  ).find((location) => existsSync(location));
  if (regular !== undefined) {
    return regular;
  }
  return CONFIG_EXTENSIONS.map((extension) =>
    join(directory, `${context.name}.config${extension}`),
  ).find((location) => existsSync(location));
}

async function loadHomeConfig(context: SourceContext, options: NodeSourceOptions) {
  const location = findHomeConfigFile(context, options);
  if (location === undefined) {
    return undefined;
  }
  if (extname(location) === '') {
    return result(JSON.parse(await readFile(location, 'utf8')), location);
  }
  const loader = createConfigLoader(options.loader);
  return result(await loadStructuredFile(location, loader), location);
}

function loadHomeConfigSync(context: SourceContext, options: NodeSourceOptions) {
  const location = findHomeConfigFile(context, options);
  if (location === undefined) {
    return undefined;
  }
  if (extname(location) === '') {
    return result(JSON.parse(readFileSync(location, 'utf8')), location);
  }
  const loader = createConfigLoader(options.loader);
  return result(loadStructuredFileSync(location, loader), location);
}

/** Create the classic `~/.name` user dotfile source. */
export function createUserDotfileSource(options: NodeSourceOptions = {}): Source {
  return {
    id: 'user-dotfile',
    kind: 'typed',
    load: (context) => loadDotfile(context, options),
    loadSync: (context) => loadDotfileSync(context, options),
  };
}

/** Create the XDG `config/name/config.*` source. */
export function createXdgConfigSource(options: NodeSourceOptions = {}): Source {
  return {
    id: 'xdg-config',
    kind: 'typed',
    load: (context) => loadXdg(context, options),
    loadSync: (context) => loadXdgSync(context, options),
  };
}

/** Create the `~/.environmentalist/name` source. */
export function createHomeConfigSource(options: NodeSourceOptions = {}): Source {
  return {
    id: 'home-config',
    kind: 'typed',
    load: (context) => loadHomeConfig(context, options),
    loadSync: (context) => loadHomeConfigSync(context, options),
  };
}

/** Alias for {@link createUserDotfileSource}. */
export const userDotfileSource = createUserDotfileSource;

/** Alias for {@link createXdgConfigSource}. */
export const xdgConfigSource = createXdgConfigSource;

/** Alias for {@link createHomeConfigSource}. */
export const homeConfigSource = createHomeConfigSource;
