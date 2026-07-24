import { $ } from 'bun';
import pkg from '../package.json' with { type: 'json' };

type PackageManifest = {
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
};

type Artifact = {
  readonly entrypoint: string;
  readonly target: 'node' | 'browser';
  readonly filename: string;
};

const manifest = pkg as PackageManifest;
const external = Array.from(
  new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]),
);

const artifacts: readonly Artifact[] = [
  { entrypoint: './src/index.ts', target: 'node', filename: 'index.node.js' },
  { entrypoint: './src/index.browser.ts', target: 'browser', filename: 'index.browser.js' },
  { entrypoint: './src/cli/index.ts', target: 'node', filename: 'cli.js' },
  { entrypoint: './src/react.ts', target: 'browser', filename: 'react.js' },
  { entrypoint: './src/svelte.ts', target: 'browser', filename: 'svelte.js' },
];

await $`rm -rf dist`;

for (const artifact of artifacts) {
  const result = await Bun.build({
    entrypoints: [artifact.entrypoint],
    outdir: './dist',
    naming: artifact.filename,
    target: artifact.target,
    format: 'esm',
    packages: 'bundle',
    sourcemap: 'linked',
    minify: false,
    external,
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join('\n'));
  }
}

await $`bun run tsc --declaration --emitDeclarationOnly --project tsconfig.build.json`;
await Bun.write('./dist/types.d.ts', Bun.file('./dist/types-entry.d.ts'));
const cliPath = './dist/cli.js';
const cli = await Bun.file(cliPath).text();
if (!cli.startsWith('#!')) await Bun.write(cliPath, `#!/usr/bin/env node\n${cli}`);
await $`chmod +x ${cliPath}`;

console.log('Build complete.');
