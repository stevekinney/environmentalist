/* eslint-disable typescript/no-unsafe-type-assertion -- test reads this repo's own package.json */

import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { exports as resolveExports } from 'resolve.exports';

const packageLocation = resolve(import.meta.dir, '..', 'package.json');

type PackageJson = {
  readonly exports: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
};

function relativeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticImports = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gu;
  const dynamicImports = /import\(\s*['"]([^'"]+)['"]\s*\)/gu;
  for (const match of source.matchAll(staticImports)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  for (const match of source.matchAll(dynamicImports)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}

function sourceCandidates(location: string): readonly string[] {
  const withoutExtension = location.replace(/\.(?:js|jsx|mjs|cjs)$/u, '');
  return [
    location,
    `${withoutExtension}.ts`,
    `${withoutExtension}.tsx`,
    `${withoutExtension}.js`,
    join(location, 'index.ts'),
  ];
}

async function importGraph(entrypoint: string): Promise<Set<string>> {
  const visited = new Set<string>();
  const pending = [resolve(import.meta.dir, entrypoint)];
  while (pending.length > 0) {
    const location = pending.pop();
    if (location === undefined || visited.has(location)) continue;
    visited.add(location);
    const source = await Bun.file(location).text();
    for (const specifier of relativeImportSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const target = sourceCandidates(resolve(dirname(location), specifier)).find(existsSync);
      if (target !== undefined) pending.push(target);
    }
  }
  return visited;
}

async function packageJson(): Promise<PackageJson> {
  return JSON.parse(await Bun.file(packageLocation).text()) as PackageJson;
}

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true })));
});

describe('package export routing and module-graph purity', () => {
  it('routes the core export to the requested runtime artifact', async () => {
    const manifest = await packageJson();
    expect(resolveExports(manifest, '.', { conditions: ['browser'], unsafe: true })).toEqual([
      './dist/index.browser.js',
    ]);
    expect(resolveExports(manifest, '.', { conditions: ['node'], unsafe: true })).toEqual([
      './dist/index.node.js',
    ]);
    expect(resolveExports(manifest, '.', { conditions: ['bun'], unsafe: true })).toEqual([
      './dist/index.node.js',
    ]);
    expect(resolveExports(manifest, '.', { conditions: [], unsafe: true })).toEqual([
      './dist/index.node.js',
    ]);
  });

  it('keeps the browser graph free of Node and toolchain specifiers', async () => {
    const graph = await importGraph('../src/index.browser.ts');
    const forbidden = /^(?:node:|fs$|os$|path$|jiti$|dotenv|toml$|yaml$|ts-morph$|typescript$)/u;
    const found: string[] = [];
    for (const location of graph) {
      for (const specifier of relativeImportSpecifiers(await Bun.file(location).text())) {
        if (forbidden.test(specifier)) found.push(`${location}: ${specifier}`);
      }
    }
    expect(found).toEqual([]);

    const outputDirectory = await mkdtemp(join(tmpdir(), 'environmentalist-packaging-'));
    temporaryDirectories.push(outputDirectory);
    const result = await Bun.build({
      entrypoints: ['src/index.browser.ts'],
      outdir: outputDirectory,
      target: 'browser',
      format: 'esm',
      external: ['change-case', 'zod'],
    });
    expect(result.success).toBe(true);
  });

  it('keeps the core graph free of the CLI compiler toolchain', async () => {
    const graph = await importGraph('../src/index.ts');
    const forbidden = /^(?:ts-morph$|typescript$)/u;
    const found: string[] = [];
    for (const location of graph) {
      for (const specifier of relativeImportSpecifiers(await Bun.file(location).text())) {
        if (forbidden.test(specifier)) found.push(`${location}: ${specifier}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('keeps zod out of dependencies and in peerDependencies', async () => {
    const manifest = await packageJson();
    expect(manifest.dependencies?.['zod']).toBeUndefined();
    expect(manifest.peerDependencies?.['zod']).toBe('^4');
  });
});
