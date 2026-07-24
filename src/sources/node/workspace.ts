import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import type { NodeSourceOptions } from './options.js';

const DEFAULT_MARKERS = [
  'pnpm-workspace.yaml',
  'bun.lockb',
  'bun.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.git',
] as const;

function markerNames(stopAt: NodeSourceOptions['stopAt']): readonly string[] {
  if (stopAt === undefined) {
    return DEFAULT_MARKERS;
  }
  return typeof stopAt === 'string' ? [stopAt] : stopAt;
}

function hasWorkspacesPackage(directory: string): boolean {
  const packagePath = join(directory, 'package.json');
  if (!existsSync(packagePath)) {
    return false;
  }

  try {
    const packageJson: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    return (
      typeof packageJson === 'object' &&
      packageJson !== null &&
      'workspaces' in packageJson &&
      (Array.isArray(packageJson.workspaces) ||
        (typeof packageJson.workspaces === 'object' && packageJson.workspaces !== null))
    );
  } catch {
    return false;
  }
}

function hasMarker(directory: string, markers: readonly string[]): boolean {
  return markers.some((marker) => existsSync(join(directory, marker)));
}

/** Find the workspace boundary used by upward source discovery. */
export function findWorkspaceRoot(cwd: string, options: NodeSourceOptions = {}): string {
  const start = resolve(cwd);
  const hardStop = options.root === undefined ? undefined : resolve(options.root);
  const markers = markerNames(options.stopAt);
  let current = start;
  let parent = dirname(start);

  while (!isBoundary(current, parent, hardStop, markers)) {
    current = parent;
    parent = dirname(current);
  }

  return current;
}

function isBoundary(
  current: string,
  parent: string,
  hardStop: string | undefined,
  markers: readonly string[],
): boolean {
  if (hardStop !== undefined && current === hardStop) {
    return true;
  }

  if (hasMarker(current, markers) || hasWorkspacesPackage(current)) {
    return true;
  }

  return shouldStopTraversal(current, parent, hardStop);
}

function shouldStopTraversal(
  current: string,
  parent: string,
  hardStop: string | undefined,
): boolean {
  return (
    parent === current || (hardStop !== undefined && relative(hardStop, current).startsWith('..'))
  );
}

/** List directories from the current working directory through its workspace root. */
export function directoriesToWorkspaceRoot(cwd: string, options: NodeSourceOptions = {}): string[] {
  const start = resolve(cwd);
  const root = findWorkspaceRoot(start, options);
  const directories: string[] = [];
  let current = start;
  directories.push(current);

  while (current !== root) {
    current = dirname(current);
    directories.push(current);
  }

  return directories;
}
