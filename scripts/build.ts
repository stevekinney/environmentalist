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

// `dist/types.d.ts` is the declaration output of `src/types.ts` and must stay
// that way. The types-only entry keeps its own emitted path, `types-entry.d.ts`,
// which the `./types` export condition points at; copying it over
// `dist/types.d.ts` used to leave a barrel re-exporting from itself, so no
// consumer could resolve `EnvironmentalistOptions` and friends.
await $`bun run tsc --declaration --emitDeclarationOnly --project tsconfig.build.json`;
// Guard the emit collision above: if `dist/types.d.ts` ever stops carrying the
// real declarations, every consumer's `EnvironmentalistOptions` silently
// resolves to nothing, which type-checks as a barrel and fails only downstream.
const declarations = await Bun.file('./dist/types.d.ts').text();
if (!declarations.includes('type EnvironmentalistOptions')) {
  throw new Error(
    'dist/types.d.ts does not declare EnvironmentalistOptions. It must be the ' +
      'declaration output of src/types.ts, not the types-entry barrel.',
  );
}

const cliPath = './dist/cli.js';
const cli = await Bun.file(cliPath).text();
if (!cli.startsWith('#!')) await Bun.write(cliPath, `#!/usr/bin/env node\n${cli}`);
await $`chmod +x ${cliPath}`;

console.log('Build complete.');
