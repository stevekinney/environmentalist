# Environmentalist

`@lostgradient/environmentalist` is a configuration resolver. You hand it a name and a [Zod](https://zod.dev) schema; it hands back a frozen, fully-typed, validated `environment` object with camelCase keys—assembled from command-line flags, environment variables, `.env` files, project config files, and a couple of well-known spots in your home directory.

The problem it solves is the one you hit on every real project: the same setting can live in five places, each with its own casing convention, and you end up hand-rolling a pile of `process.env.FOO ?? argv.foo ?? config.foo ?? 'default'` fallbacks that nobody wants to maintain. Environmentalist makes that pile declarative. You describe what the config _is_ once, in Zod, and the resolution rules stay consistent, ordered, and testable.

## Installation

```bash
bun add @lostgradient/environmentalist zod
```

`zod@^4` is a peer dependency, so there's exactly one copy of Zod shared between your schema and the validator. Two copies produce structurally-similar-but-nominally-different types, and inference quietly rots to `unknown` at the seams.

The package is ESM-only and targets Node ≥ 22 and Bun ≥ 1.3.

## Quick start

```ts
import { z } from 'zod';
import { environmentalist } from '@lostgradient/environmentalist';

const environment = await environmentalist({
  name: 'bowowwow',
  schema: z.object({
    mode: z.string().default('development'),
    PORT: z.number().default(3000),
    ANTHROPIC_API_KEY: z.string(),
  }),
});

environment.mode; // string
environment.port; // number — coerced from the string an env var gave us
environment.anthropicApiKey; // string
```

Notice the shape flip: you wrote `ANTHROPIC_API_KEY` in the schema, but you read `environment.anthropicApiKey`. That camelCase remapping is the core mental model, so let's start there.

## The canonical key model

Every key normalizes to one **canonical form**: camelCase. Whatever you write in the schema—`mode`, `ANTHROPIC_API_KEY`, `anthropic-api-key`—collapses to a camelCase canonical key, and _that_ is what shows up on the returned object.

From the canonical key, Environmentalist derives the spelling each source expects:

| Source               | Casing                 | `anthropicApiKey` becomes |
| -------------------- | ---------------------- | ------------------------- |
| Environment variable | `SCREAMING_SNAKE_CASE` | `ANTHROPIC_API_KEY`       |
| CLI flag             | `kebab-case`           | `--anthropic-api-key`     |
| Config file property | canonical `camelCase`  | `anthropicApiKey`         |

Incoming keys from _every_ source normalize to the canonical form before matching, so a config file can spell a key `anthropicApiKey`, `ANTHROPIC_API_KEY`, or `anthropic-api-key` and they all land in the same slot. The return type reflects the flip too—it's a deep, type-level camelCase remap of the schema's **output** type, so the compiler sees `environment.anthropicApiKey` and never `environment.ANTHROPIC_API_KEY`.

Two keys that collapse to the same canonical form are a construction-time `EnvironmentalistError` naming both offenders. The type system can't catch that one, so it fails loudly instead of silently last-wins-ing.

## Resolution order

Values resolve **per key**, highest priority first. Any source can supply any subset of keys—env can provide `anthropicApiKey` while a project config file provides `mode`, and they compose into one result.

Under Node and Bun:

1. **CLI flags**: `--anthropic-api-key=sk-…` or `--anthropic-api-key sk-…`, parsed from `process.argv`.
2. **URL search parameters**: the `search` option, for contexts with no argv—an SSR request, an Electron deep-link.
3. **Real environment variables**: `process.env`, i.e. what's actually exported into the process.
4. **`.env` file cascade**: `.env.$mode.local` → `.env.local` → `.env.$mode` → `.env`.
5. **Project config files**: `$name.config.*`, discovered by climbing from `cwd` to the workspace root. The **nearest** file wins.
6. **`package.json`**: a `$name` key inside the nearest `package.json`.
7. **`~/.$name`**: the classic user dotfile.
8. **`~/.config/$name/config.*`**: the XDG-style user config directory (honors `$XDG_CONFIG_HOME`).
9. **`~/.environmentalist/$name`**: the tool-managed home location.
10. **Schema defaults**: whatever `.default()` you declared in Zod. The floor.

The principle is _most-explicit-wins_: a flag you typed for this one run beats an exported env var, which beats a committed config file, which beats a global dotfile, which beats a hardcoded default. It matches what you already expect from `npm` and `eslint`, so nobody has to memorize a surprising rule.

> [!NOTE] Why `.env` sits below the real environment
> `.env` files are a developer convenience, and by convention (`dotenv`, Vite, Next) they do _not_ override variables already set in the actual environment. If CI exports `ANTHROPIC_API_KEY`, a stray `.env` on the build box shouldn't quietly win.

Each built-in source has a stable **id**—`flags`, `search-params`, `env`, `dotenv`, `project-config`, `package-json`, `user-dotfile`, `xdg-config`, `home-config`, `defaults`—and those ids are exactly what the provenance map reports and what `exclude` names. Use `exclude` when you want the defaults minus a source or two, and `sources` when you want to replace or reorder the chain wholesale.

```ts
await environmentalist({ name: 'bowowwow', schema, exclude: ['env', 'dotenv'] });
```

### The mode chicken-and-egg

The `.env` cascade references `$mode`, but `mode` is itself a resolved key. Environmentalist resolves it in two passes: a **pre-pass** reads only the mode key from the file-free sources (flags, then `process.env`—both `MODE` and the conventional `NODE_ENV`—then the schema default), and the full resolution then expands the cascade against that value. `modeKey` is configurable, because some apps call it `env` or `stage`.

## Sources in detail

### CLI flags

Flags parse from `process.argv` (override with `argv` for testing). As the top-priority source, it gets the richest parser: `--key value` and `--key=value` both work, booleans negate with `--no-verbose`, short aliases map through the `aliases` option, repeats build arrays (`--tag a --tag b` → `['a', 'b']`), dot paths nest (`--server.port=3000`), and a bare `--` terminates parsing.

Everything after that terminator—and any bare argument that isn't consumed as a flag name or a flag's value—is a **positional**, not config. Environmentalist's own resolution ignores positionals entirely, but `parsePositionals(argv, options?)` collects them (same `aliases`/`flagOverrides` options as `parseFlags`, since those affect what counts as a flag's value), and `matchPositionals(positionals, spec)` maps that list onto named slots:

```ts
import { matchPositionals, parsePositionals } from '@lostgradient/environmentalist';

const positionals = parsePositionals(process.argv.slice(2));
// ['build', 'src/index.ts']

const { command, files } = matchPositionals(positionals, [
  { name: 'command' },
  { name: 'files', variadic: true },
]);
// { command: 'build', files: ['src/index.ts'] }
```

Each `PositionalSpec` entry takes a `name`, an optional `description`, `required` (defaults to `true`, or `false` for a `variadic` entry), and `variadic` (consumes every remaining positional; only the last entry may set it). `matchPositionals` throws an `EnvironmentalistError` for a missing required entry, an extra positional with no matching spec entry, or a malformed spec (a non-trailing variadic, or a required entry after an optional one).

These are standalone utilities—positionals never merge into the resolved `Environment`, since they don't correspond to schema keys. Environmentalist resolves named config; pair it with a command dispatcher (`commander`, `cac`, …) for subcommands and positional-driven CLI grammar.

### Generating `--help` text

`generateHelp({ name, schema, description?, usage?, positionals? })` renders usage text from a schema's top-level fields—flag name (respecting `flag` metadata overrides), inferred type, `(required)` or `(default: …)`, `(secret)`, and the field's `description` metadata—plus an optional `positionals` list (using the same `PositionalSpec` shape as `matchPositionals`):

```ts
import { generateHelp } from '@lostgradient/environmentalist';

console.log(
  generateHelp({
    name: 'bowowwow',
    schema,
    description: 'Bark responsibly.',
    positionals: [{ name: 'command', description: 'Which command to run' }],
  }),
);
```

Only top-level keys get their own row—nested keys still resolve via dot-path flags, they just don't get individually documented. Wire it to `--help` yourself; Environmentalist doesn't intercept flags on your behalf.

### Environment variables

Each canonical key is looked up as its `constantCase` form. Nesting uses a double-underscore delimiter: `SERVER__PORT` maps to `{ server: { port } }`.

The lookup is bare by default—`mode` reads `MODE`. Because bare names like `MODE`, `PORT`, and `HOME` collide with things you don't own, `envPrefix` is a first-class escape hatch: `envPrefix: 'BOWOWWOW'` means `mode` reads `BOWOWWOW_MODE`. Set one for anything real.

### Config files

For each directory from `cwd` up to the detected workspace root, Environmentalist looks for `$name.config.<ext>`, taking the first hit per directory:

`.ts` → `.mts` → `.cts` → `.js` → `.mjs` → `.cjs` → `.json` → `.jsonc` → `.toml` → `.yaml` → `.yml`

A file that default-exports an object is used directly; one that exports a function is called and its return value used. Workspace root auto-detects from a `pnpm-workspace.yaml`, a `package.json` with `workspaces`, a lockfile, or a `.git` directory—override with `root`/`stopAt`.

Loading a `.ts` config means executing TypeScript, and the loader picks the cheapest path for where it's running: native `import()` under Bun and other TS-native runtimes, [`jiti`](https://github.com/unjs/jiti) on plain Node. Force it with `loader`.

> [!WARNING] Trust boundary
> Loading a `.ts`/`.js` config file _executes code_. That's fine for a project file you committed, but the home-directory sources execute code owned by the user, not the project. Standard for config tools, worth knowing.

For typed config files, use `defineConfig`:

```ts
// bowowwow.config.ts
import { defineConfig } from '@lostgradient/environmentalist';

export default defineConfig({ mode: 'production' });
```

Parameterize it (`defineConfig<Environment>`) and you trade the forgiving-casing tolerance for compile-time key checking, which is the right default for a `.ts` config. The any-casing tolerance stays a runtime convenience for hand-written JSON/TOML/YAML.

## Coercion

Everything from flags, env, and `.env` arrives as a string, but your schema might say `z.number()`. String-origin sources pass through a coercion preprocess before validation: Zod modifiers (`optional`, `nullable`, `default`, `catch`) unwrap to find the target type, then `number`/`bigint` parse numerically, `boolean` reads `true/1/yes/on` versus `false/0/no/off`, `date` becomes a `Date`, and `array`/`object` go through `JSON.parse`.

So `z.number()` just works from an env var without reaching for `z.coerce.number()`. File sources already carry real types, so they bypass coercion untouched. Pass `coerce: false` to opt out entirely.

## Validation and errors

After merging and coercing, the assembled object validates in a single `safeParse`. On failure Environmentalist collects **every** problem across every key and throws one `EnvironmentalistError`—no fixing one missing variable per run.

```
✖ Environmentalist could not resolve configuration for "bowowwow" (2 problems)
  anthropicApiKey — required, but not found
    Anthropic API key used for model calls.
    Example: [redacted]
    Checked:  flag --anthropic-api-key · env ANTHROPIC_API_KEY · .env · bowowwow.config.* · ~/.bowowwow · schema defaults
    Fix:      export ANTHROPIC_API_KEY=…, or pass --anthropic-api-key=…, or add anthropicApiKey to bowowwow.config.ts
    Docs:     https://docs.anthropic.com/
  port — expected number, received "three thousand"
    Port the server binds to.
    Source:   env process.env (= "three thousand")
    Fix:      set PORT to an integer
```

Every line there generates from the schema plus its metadata—no hand-written error strings per field, so the errors stay in sync as the schema changes. The bad `port` value prints because seeing it helps; the secret's example is masked because seeing it doesn't.

For callers who'd rather not catch, `environmentalist.safe(options)` returns `{ success, data }` or `{ success, error }` instead of throwing.

## Metadata

Zod v4 ships a real metadata system, and Environmentalist leans on it hard—config is exactly the place where a schema should double as its own documentation.

```ts
import { z } from 'zod';
import { environmentalist, secret } from '@lostgradient/environmentalist';

const schema = z.object({
  ANTHROPIC_API_KEY: secret(
    z.string().meta({
      description: 'Anthropic API key used for model calls.',
      example: 'sk-ant-…',
      docs: 'https://docs.anthropic.com/',
    }),
  ),
  DATABASE_URL: z.string().meta({ env: 'DATABASE_URL' }), // force the exact env name
  port: z.number().default(3000).meta({ description: 'Port the server binds to.' }),
});
```

Recognized keys: `description`, `example`, `docs`, `secret`, plus two per-field source overrides. (`deprecated` is accepted by the registry's type but nothing reads it yet.) `env` forces a specific environment-variable name—_replacing_ the derived casing and any `envPrefix`, so the derived spelling is no longer consulted for that field. That's what lets you bind to a variable you don't control without a generic name like `FILE` hijacking it, and it applies to every source that reads variables by name: the real environment, the `.env` cascade, and `import.meta.env`. `flag` does the same for a flag name.

That one metadata source powers everything downstream: the actionable errors above, JSON Schema export, `.env.example` scaffolding, and the `print` command's annotated table. Write the docs once, on the schema.

## Secrets

Mark a field with `secret()` (sugar for `.meta({ secret: true })`) and Environmentalist treats it as radioactive. Secret keys are redacted in thrown errors, in provenance output, and in the object's `toJSON` and `util.inspect` representations—so `console.log(environment)` or a crash dump never leaks a key:

```ts
JSON.stringify(environment);
// {"mode":"production","port":8080,"anthropicApiKey":"[redacted]"}

environment.anthropicApiKey; // the real value — only serialized forms are masked
```

Secret-marked keys are also ignored from URL search params by default, since query strings leak into browser history, server logs, and `Referer` headers.

For crossing a process boundary, `toPublic(environment)` returns a new object with every secret-marked field omitted—safe to send over Electron IPC or inline into an HTML page.

## Provenance

The returned object carries a non-enumerable provenance map, so "why is this value what it is?" is always answerable. It hides behind a symbol to keep it off the typed surface:

```ts
import { SOURCES, SCHEMA } from '@lostgradient/environmentalist';

environment[SOURCES].port; // → { source: 'env', location: 'process.env' }
environment[SOURCES].mode; // → { source: 'flags', location: 'argv' }
environment[SCHEMA]; // → the Zod schema it was built from
```

Pass an `onResolve` hook to capture the full resolution trace. Secret values are redacted there too.

## Watch mode

Config isn't always static. `environmentalist.watch()` re-resolves on change and hands it to you through whichever interface fits—an event, an async iterator, or a subscription a framework can bind to.

```ts
const watcher = environmentalist.watch({ name: 'bowowwow', schema, interval: 1000 });

await watcher.ready; // first resolution done
watcher.current; // latest valid Environment<S>

watcher.on('change', ({ environment, previous, changes }) => {
  // changes: [{ key: 'mode', from: 'development', to: 'production', source: 'dotenv' }]
});

for await (const environment of watcher) {
  // yields the new snapshot on every change
}

await watcher.close(); // or: await using watcher = environmentalist.watch(…)
```

Detection is **native-first, chosen per source**. The watcher looks at which sources actually fed the resolved config—the same provenance it already tracks—and subscribes to each one's native change signal where there is one: `fs.watch` for config and `.env` files, the `storage` event for `localStorage`. Only the sources with no native signal fall back to polling, and a poll tick schedules on the platform's idle scheduler rather than a hard timer that competes with your app's work. Set `strategy: 'poll'` to force polling everywhere.

If a reload fails validation the watcher does _not_ hand you a broken object. It keeps the last-good `current`, emits an `error` event, and keeps watching—so a fat-fingered `.env` edit surfaces instead of crashing a running process, and recovers when the file is fixed.

Two properties make framework bindings cheap. Every change produces a new frozen object, and when nothing changed `getSnapshot()` returns the _same reference_—that stability is what keeps React from looping. And because config is state rather than a message stream, the async iterator coalesces: a slow consumer gets the latest snapshot, never a backlog of stale ones.

### Framework bindings

The watcher exposes `subscribe(cb)` and `getSnapshot()`, deliberately the shape of both React's `useSyncExternalStore` and Svelte's store contract. `react` and `svelte` are optional peer dependencies; the core watcher has no framework knowledge.

```tsx
import { useEnvironment } from '@lostgradient/environmentalist/react';

function StatusBar() {
  const environment = useEnvironment(watcher);
  return <span>{environment.mode}</span>;
}
```

The Svelte subpath ships `createEnvironment(watcher)`, which returns a getter-backed `{ current }` view, and `toStore(watcher)`, which adapts the watcher to Svelte's immediate-subscription store shape. Both are deliberately compiler-free plain TypeScript—wrap the view in `$state` inside a component if you want rune reactivity.

```svelte
<script lang="ts">
  import { toStore } from '@lostgradient/environmentalist/svelte';
  const environment = toStore(watcher);
</script>

<span>{$environment.mode}</span>
```

## Options

```ts
type EnvironmentalistOptions<S extends z.ZodObject> = {
  name: string; // required — drives file names and home paths
  schema: S; // required — a Zod object schema
  cwd?: string; // where discovery starts (default: process.cwd())
  root?: string; // hard stop for upward traversal
  stopAt?: string | readonly string[]; // marker files defining the workspace root
  modeKey?: CanonicalKey<S>; // key selecting the .env mode (default: 'mode')
  envPrefix?: string; // scope env-var lookups (default: none)
  env?: Record<string, string>; // env source (default: process.env)
  argv?: readonly string[]; // flag source (default: process.argv)
  aliases?: Record<string, CanonicalKey<S>>; // short flag → canonical key
  search?: string | URL | URLSearchParams; // URL query source
  dotenv?: boolean | DotenvOptions; // load the .env cascade (default: true)
  coerce?: boolean; // auto-coerce string sources (default: true)
  loader?: 'auto' | 'bun' | 'jiti' | ConfigLoader; // TS/JS config loader
  sources?: readonly SourceSpec[]; // replace the resolution chain wholesale
  exclude?: readonly SourceName[]; // drop built-in sources by id
  onResolve?: (trace: ResolutionTrace) => void; // provenance/debug hook
};
```

`modeKey` and `aliases` values are constrained to the canonical camelCase keys, so a typo in an option is a compile error rather than a silent no-op. Watch mode layers `interval`, `strategy`, `signal`, `emitInitial`, and `equals` on top.

## API surface

```ts
environmentalist(options): Promise<Environment<S>>
environmentalist.safe(options): Promise<SafeResult<S>>
environmentalist.sync(options): Environment<S>       // env, flags, .env, .json/.toml/.yaml,
environmentalist.safeSync(options): SafeResult<S>    // precompiled .js — plus .ts under Bun
environmentalist.watch(options): Watcher<S>
environmentalist.initialize(options): Promise<void>

toJSONSchema(schema)                  // JSON Schema, descriptions and examples carried through
toPublic(environment)                 // strips secret-marked fields
defineConfig(config)                  // typed config files
secret(schema)                        // sugar for .meta({ secret: true })
registry                              // typed Zod registry for the metadata above
createWatcher(options)                // the watcher without going through the resolver
electronPaths(appName)                // platform userData directories
createUserDataConfigSource(options)   // a source reading an Electron userData config
SOURCES, SCHEMA                       // provenance and back-reference symbols
class EnvironmentalistError extends Error

type Environment<S> = Readonly<CamelCasedPropertiesDeep<z.output<S>>>
  & { readonly [SOURCES]: SourceMap<S>; readonly [SCHEMA]: S };
```

`Environment<S>` is frozen, camelCase-keyed, and built from the schema's **output** type—`.default()` applied, `.transform()` run, coercion done—so a defaulted field is non-optional on the returned type.

Types-only consumers (an Electron renderer, an IPC boundary) can import from the `./types` subpath with no runtime import at all:

```ts
import type { Environment } from '@lostgradient/environmentalist/types';
```

> [!NOTE] Object modes
> `strip` (the default) and `strict` object schemas map cleanly. `.passthrough()` and `.catchall()` introduce an index signature the deep remap can't meaningfully case, so they're rejected at construction with an explanatory error.

## Command-line interface

The `environmentalist` bin reuses the same runtime-aware loader the library does. Point a subcommand at a module and it locates the schema—via a named export (`--export`, defaulting to `environment`, then `schema`, then the default export), via the `SCHEMA` back-reference on an already-resolved environment, or by statically locating the `environmentalist({ schema })` call with ts-morph.

```bash
environmentalist types <entry> [--out file] [--type-name Name] [--kind input|output] [--static] [--format d.ts|ts]
environmentalist initialize [entry] [--name name] [--format ts|json|toml|yaml] [--env-example] [--cwd directory]
environmentalist schema <entry> [--export name] [--out file]
environmentalist print <entry> [--export name] [--name name]
```

`types` generates a concrete, materialized TypeScript type for the resolved environment. The value is a _portable, flat_ type—no dependency on the `CamelCasedPropertiesDeep` machinery and no runtime import needed to consume it, which makes it the natural IPC contract for an Electron split. It defaults to loading the module for accuracy; `--static` never executes it, using the TypeScript type checker instead, which is what you want for an entry file with import-time side effects.

`print` resolves the environment and prints the provenance table with secrets redacted and descriptions attached. It's the debugging command.

> [!NOTE] Not yet implemented
> `types` accepts `--augment`, `--watch`, and `--sources` but currently errors with "not implemented yet" for each.

The CLI carries `ts-morph` (and therefore the TypeScript compiler) as an optional dependency. It's scoped to the bin, so importing the library never pulls the compiler into your graph.

## Browser support

The resolution engine—canonical keys, per-key precedence, coercion, validation, provenance, redaction, watch—is platform-neutral. Only the sources and the config loader are platform-specific, so the browser is just another adapter selected by the `browser` export condition. Vite, webpack, and esbuild all honor it automatically, and you get a build with no `fs`, `os`, `path`, `jiti`, or `dotenv` in the graph.

Browser sources, highest priority first:

1. **URL query params**: `window.location.search` by default; the browser analog of CLI flags.
2. **Injected global**: `window.__BOWOWWOW__`, an object a server inlines into the HTML for SSR/hydration.
3. **`localStorage`**: a JSON blob under `environmentalist:$name`—user overrides and dev toggles.
4. **Build-time env**: `import.meta.env` (Vite) or a bundler `define`.
5. **Schema defaults**: the floor, same as everywhere.

Two hard constraints. There's **no `.ts` config in the browser**—no jiti, no filesystem—so config is data, and `defineConfig` and the file loaders are Node/Bun only. And **the browser keeps no secrets**: anything shipped to the client is public, full stop. Redaction still scrubs logs, but the real rule is to resolve secrets server-side and hand the browser only the `toPublic()` subset.

## Electron and Electrobun

Resolve in the **main process only**. A renderer with secure defaults has no `fs`, no real `process.env`, and no directory traversal, so resolution happens once at startup in main and the public subset crosses over IPC. That makes the renderer the browser adapter receiving an injected config, not a special case.

A packaged app doesn't keep config next to a `.git` root—it uses the OS per-user application-data directory. Pass the real `app.getPath('userData')` in when you can, since only Electron knows about `productName`, `app.setPath`, and portable mode. When Electron can't be imported (the `types` CLI, tests, a preload before `app` is ready), `electronPaths(appName)` reproduces the platform defaults from `os` and `process.env`:

| OS      | Typical `userData` for an app named "Bowowwow"      |
| ------- | --------------------------------------------------- |
| macOS   | `~/Library/Application Support/Bowowwow`            |
| Windows | `%APPDATA%\Bowowwow`                                |
| Linux   | `$XDG_CONFIG_HOME/Bowowwow` or `~/.config/Bowowwow` |

`createUserDataConfigSource` reads `$name.config.*` and `electron-store`'s `config.json` format from that directory, so an app already using electron-store is picked up with no migration.

Two things to design around. **Env vars and flags are unreliable for GUI launches**—a double-clicked app doesn't inherit your shell environment, so file sources do the real work and env/flags are a dev-time convenience. And **don't runtime-transpile `.ts` config in production**: loading `.ts` from inside an `.asar` with jiti is fragile. Ship JSON or precompiled config and use the sync path.

## Contributing

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3.

### Commands

```bash
bun run dev          # watch mode
bun run build        # build to dist/
bun test             # run the test suite
bun run check        # fast sanity: format:check + lint + typecheck
bun run validate     # the full gate, same as pre-push and CI
```

### Project structure

- `src/` — source. The neutral core plus platform adapters under `src/sources/` and `src/platform/`
- `test/` — shared test setup (`test/setup.ts` is preloaded by `bun test`)
- `scripts/` — build script and Git hook implementations
- `DESIGN.md` — the original design specification

Published `src/` code must not use Bun-only runtime APIs (`Bun.file`, `Bun.serve`, etc.)—those belong in `scripts/` and tests only, since the Node artifact has to run on plain Node.

### Tests

Test files are colocated with sources using the `.test.ts` suffix, and `test/setup.ts` resets mocks and system time after each one. Coverage thresholds live in `bunfig.toml` and the floor is 100% for `src/`.

```bash
bun test --watch
bun test --coverage
```

### Git hooks

Lefthook installs via the `prepare` script on `bun install`. `pre-commit` formats and lints staged files, blocks staged conflict markers, and checks that `bun.lock` is staged when `package.json` changes—fast by design, with typecheck and tests deferred to `pre-push`, which runs the full `bun run validate`. Hooks print only on failure, so clean commits stay quiet.

### Continuous integration

`.github/workflows/ci.yaml` runs `bun run validate` on every push and pull request against Node 22 and Node 24, then smoke-tests the emitted Node bundle under each matrix version—`validate` itself runs entirely under Bun, so that step is what makes the matrix meaningful.

### Library output

One build emits every artifact from shared source:

- `dist/index.node.js` — Node-family build (`Bun.build target: 'node'`)
- `dist/index.browser.js` — browser build (`Bun.build target: 'browser'`)
- `dist/cli.js`, `dist/react.js`, `dist/svelte.js` — CLI and optional framework entries
- `dist/index.d.ts` — shared TypeScript declarations

A thin platform module resolved per entry swaps `fs`/`jiti`/`fs.watch`/`setImmediate` for the browser's storage-event and `requestIdleCallback` set, so no Node built-in lands in the browser artifact. The `exports` map routes conditions to the two runtime artifacts, and since the package is ESM-only there's no CJS twin and no dual-package hazard.

`declarationMap` is on and `src/` ships in the tarball (minus tests), so go-to-definition lands on real source.

### Releasing

Releases are tag-driven and tokenless. `.github/workflows/release.yaml` publishes to npm using [trusted publishing](https://docs.npmjs.com/trusted-publishers)—GitHub Actions mints a short-lived OIDC token, so there is no `NPM_TOKEN` secret in this repository.

```bash
npm version patch   # or minor / major — commits and tags vX.Y.Z
git push --follow-tags
```

Pushing the tag triggers `release.yaml`, which verifies the tag matches `package.json`, runs `bun run validate`, and publishes with npm provenance.

The trusted publisher is already configured for this package, bound to the GitHub repository and the workflow **filename**. Renaming `.github/workflows/release.yaml` breaks publishing until the npm-side configuration is updated to match. `NPM_CONFIG_PROVENANCE` lives in the workflow rather than in `publishConfig` on purpose—provenance requires a supported CI, so putting it in `package.json` would break any local publish.

`publishConfig.access` is `public`, which is what makes a scoped package public; npm otherwise defaults scoped packages to restricted.

## License

MIT © Steve Kinney
