# Environmentalist — Design Specification

`@lostgradient/environmentalist` is a configuration resolver. You hand it a name and a [Zod](https://zod.dev) schema; it hands you back a fully-typed, validated `environment` object with camelCase keys—assembled from command-line flags, environment variables, `.env` files, project config files, and a couple of well-known spots in your home directory. One schema, one call, one place that knows how your app is configured.

The problem it solves is the one you hit on every real project: the same setting can live in five places, each with its own casing convention, and you end up hand-rolling a pile of `process.env.FOO ?? argv.foo ?? config.foo ?? 'default'` fallbacks that nobody wants to maintain. Environmentalist makes that pile declarative. You describe what the config _is_ once, in Zod, and the resolution rules are consistent, ordered, and testable.

```ts
import { z } from 'zod';
import { environmentalist } from '@lostgradient/environmentalist';
const environment = await environmentalist({
  name: 'bowowwow',
  schema: z.object({
    mode: z.string().default('development'),
    ANTHROPIC_API_KEY: z.string(),
  }),
});
environment.mode; // string
environment.anthropicApiKey; // string
```

Notice the shape flip: you wrote `ANTHROPIC_API_KEY` in the schema, but you read `environment.anthropicApiKey`. That camelCase remapping is the core mental model, so let's start there.

> [!NOTE]
> This is a design spec, not documentation for a shipped thing. Anything in the "Non-goals and future work" section is explicitly _out_ of the first version. The acceptance criteria at the bottom are the definition of done.

## The canonical key model

Every key gets normalized to one **canonical form**: camelCase. Whatever you write in the schema (`mode`, `ANTHROPIC_API_KEY`, `anthropic-api-key`—doesn't matter) collapses to a camelCase canonical key (`mode`, `anthropicApiKey`), and _that_ is what shows up on the returned object.

From the canonical key, Environmentalist derives the spelling each source expects, using [`change-case`](https://github.com/blakeembrey/change-case):

| Source               | Casing                 | `anthropicApiKey` becomes | Function       |
| -------------------- | ---------------------- | ------------------------- | -------------- |
| Environment variable | `SCREAMING_SNAKE_CASE` | `ANTHROPIC_API_KEY`       | `constantCase` |
| CLI flag             | `kebab-case`           | `--anthropic-api-key`     | `kebabCase`    |
| Config file property | canonical `camelCase`  | `anthropicApiKey`         | `camelCase`    |

Incoming keys from _every_ source are normalized to the canonical form before matching, so a config file can spell a key `anthropicApiKey`, `ANTHROPIC_API_KEY`, or `anthropic-api-key` and they all resolve to the same slot. This is the "most forgiving" behavior—lean on `change-case` for the round-trip and stop worrying about how a given file happened to spell things.

The returned object's _type_ has to reflect the flip too. `z.infer` on the schema gives you `{ ANTHROPIC_API_KEY: string }`, but the object is `{ anthropicApiKey: string }`. So the public return type is a type-level camelCase remap of the inferred type—a `CamelCasedProperties<z.infer<S>>`. Ship this as an internal type utility (or depend on `type-fest`'s `CamelCasedProperties` for types only) so the compiler sees `environment.anthropicApiKey`, not `environment.ANTHROPIC_API_KEY`.

## Resolution order

Values resolve **per key**, highest priority first. Any source can supply any subset of keys—env can provide `anthropicApiKey` while a project config file provides `mode`, and they compose into one result. The first source (top of this list) that provides a value for a given key wins that key.

1. **CLI flags** — `--anthropic-api-key=sk-…` or `--anthropic-api-key sk-…`, parsed from `process.argv`.
2. **Real environment variables** — `process.env`, i.e. what's actually exported into the process.
3. **`.env` file cascade** — loaded but never allowed to clobber a real environment variable. Within the cascade, more-specific files win:
   1. `.env.$mode.local`
   2. `.env.local`
   3. `.env.$mode`
   4. `.env`
4. **Project config files** — `bowowwow.config.*`, discovered by climbing from `cwd` to the workspace root. The **nearest** file wins over farther-up ones (a package-level config overrides the monorepo-root config).
5. **`~/.$name`** — the classic user dotfile (e.g. `~/.bowowwow`).
6. **`~/.config/$name/config.*`** — the XDG-style user config directory (honors `$XDG_CONFIG_HOME`).
7. **`~/.environmentalist/$name`** — the tool-managed home location; where `initialize` scaffolds a global config and where multiple apps' configs can live side by side.
8. **Schema defaults** — whatever `.default()` you declared in Zod. The floor.

The precedence principle is _most-explicit-wins_: a flag you typed for this one run beats an exported env var, which beats a committed config file, which beats a global dotfile, which beats a hardcoded default. It matches what people already expect from tools like `npm` and `eslint`, so nobody has to memorize a surprising rule.

> [!NOTE] Why `.env` sits below the real environment
> `.env` files are a developer convenience, and by convention (`dotenv`, Vite, Next) they do _not_ override variables that are already set in the actual environment. If CI exports `ANTHROPIC_API_KEY`, a stray `.env` on the build box shouldn't quietly win. So real `process.env` (layer 2) is strictly above the `.env` cascade (layer 3).

The three home locations (5, 6, 7) are ordered from most-conventional to tool-managed, and the whole ordering is overridable via the `sources` option (see the options reference) for anyone who needs something different—or trimmable with `exclude` when you just want the defaults minus a source or two. One more optional source slots in near the top when present: a **URL search-params** source (the `search` option, or `window.location.search` in the browser) sits just below CLI flags—it's the flag-equivalent for contexts without an argv, like an SSR request or an Electron renderer.

## The mode chicken-and-egg

The `.env` cascade references `$mode`—but `mode` is itself a resolved key, and it might come from a flag, an env var, or a schema default. You can't load `.env.$mode` until you know the mode, and you can't fully know the config until you've loaded `.env.$mode`.

Resolve it in two passes. First, do a **pre-pass** that resolves _only_ the mode key from the fast, file-free sources: CLI flags, then `process.env` (both the canonical `MODE` and the conventional `NODE_ENV`), then the schema's `.default()` for `mode`. That gives you `$mode`. Then run the full resolution with the `.env` cascade expanded against that value. Document that `mode` is the default "mode-selecting" key and make it configurable (`modeKey: 'mode'`), because some apps call it `env` or `stage`.

## Sources in detail

### CLI flags

Flags are parsed from `process.argv` (override with the `argv` option for testing). Because this is the top-priority, most-explicit source, it earns the richest parser:

- `--key value` and `--key=value` are both accepted.
- Booleans support negation: `--verbose` sets `true`, `--no-verbose` sets `false`.
- Short aliases map to canonical keys via an `aliases` option (`{ k: 'anthropicApiKey' }`).
- Repeating a flag builds an array: `--tag a --tag b` → `['a', 'b']`.
- Nested keys use dot paths: `--server.port=3000` targets `{ server: { port } }`.
- A bare `--` terminates flag parsing; everything after is positional and ignored by the resolver.

Keep the parser in-house and small (no `yargs`); `mri`-style parsing plus the schema-driven coercion below is enough. All parsed values start as strings (or arrays of strings) and go through coercion before validation.

### URL search parameters

A `search-params` source reads configuration from a URL's query string, using the same casing and parsing rules as CLI flags—kebab-case keys (`?anthropic-api-key=sk-…`), repeats build arrays (`?tag=a&tag=b`), and dot paths nest (`?server.port=3000`). It's the flag-equivalent for the places that don't have an argv.

In the browser it defaults to `window.location.search`. Everywhere else you feed it explicitly through the `search` option, which accepts a full `URL`, a `URLSearchParams`, or a raw query string—so an SSR handler can pass the request URL, or an Electron renderer its deep-link. Like flags, it sits near the top of precedence (most-explicit), and its values are strings that go through coercion before validation.

One safety rule: `secret`-marked keys are ignored from URL params by default, because query strings leak into browser history, server logs, and `Referer` headers. You can override that per key with metadata if you truly mean it, but the default keeps API keys out of URLs.

### Environment variables

Read from `process.env` by default (override with the `env` option). Each canonical key is looked up as its `constantCase` form. Nesting uses a double-underscore delimiter: `SERVER__PORT` maps to `{ server: { port } }`.

By default the lookup is bare—`mode` reads `MODE`. Because bare names like `MODE`, `PORT`, and `HOME` collide with things you don't own, `envPrefix` is a first-class escape hatch: `envPrefix: 'BOWOWWOW'` means `mode` reads `BOWOWWOW_MODE`. The default stays off to match the zero-config example above, but the docs should recommend setting a prefix for anything real.

### `.env` files

Loaded with `dotenv` semantics plus `dotenv-expand` for `${VAR}` interpolation, so one entry can reference another. The cascade order is listed above. `.env` files never override real environment variables. The set of files is derived from `$name` only in that they live at the project root/cwd—they are not named after `$name` (they're just `.env*`), which is the convention everyone already has.

### Config files

For each directory from `cwd` up to the detected workspace root, look for `$name.config.<ext>`, trying extensions in this order and taking the first hit per directory:

`.ts` → `.mts` → `.cts` → `.js` → `.mjs` → `.cjs` → `.json` → `.jsonc` → `.toml` → `.yaml` → `.yml`

A file that `export default`s (or `module.exports =`) an object is used directly; a file that exports a function is called and its return value used (supports `defineConfig`, below). JSON/TOML/YAML are parsed with their respective parsers (`toml` and `yaml` packages). Also honor a `$name` key inside the nearest `package.json` as a low-priority config-file source, since cosmiconfig users expect that.

Workspace root is auto-detected: stop climbing at the first directory containing a `pnpm-workspace.yaml`, a `package.json` with a `workspaces` field, a lockfile (`bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`), or a `.git` directory. Override with `root`/`stopAt` and change the starting point with `cwd`.

### The runtime-aware loader

Loading `bowowwow.config.ts` means executing TypeScript, and how you do that depends on where you're running. Detect the runtime and use the cheapest path:

- **Bun** — `import()` handles `.ts` natively; no transpile needed. (This also lets the sync path load `.ts` under Bun.)
- **`tsx` / Deno / other TS-native runtimes** — same story, native `import()`.
- **Vite / bundled dev servers** — if the resolver is running inside a Vite process, prefer the host's module loading; otherwise fall through.
- **Plain Node** — fall back to [`jiti`](https://github.com/unjs/jiti) for on-the-fly TS/ESM loading with caching.

Expose a `loader` option so a consumer can force a specific strategy or inject their own. The point is that under Bun or Vite you don't pay for a second transpiler you don't need.

## Coercion

Everything from flags, env, and `.env` arrives as a string, but your schema might say `z.number()` or `z.boolean()`. String-origin sources pass through a **coercion preprocess** before validation:

- Unwrap Zod modifiers (`optional`, `nullable`, `default`, `catch`) to find the target type.
- `number`/`bigint` → numeric parse; `boolean` → `true/1/yes/on` vs `false/0/no/off`; `date` → `Date`; `array`/`object` → `JSON.parse`; everything else stays a string.
- File sources (`.ts`/`.js`/`.json`/`.toml`/`.yaml`) already carry real types, so they **bypass** coercion and pass through untouched.

This means `z.number()` just works from an env var without the user reaching for `z.coerce.number()`. Provide `coerce: false` to opt out entirely for people who'd rather be explicit. Because coercion reads Zod internals to find target types, the package pins `zod@^4` as a peer dependency.

## Validation and errors

After merging and coercing, the assembled object is validated against the schema with a single `schema.safeParse`. On failure, **collect every problem across every key** and throw one `EnvironmentalistError`. The error message is the product's front door when something's misconfigured, so make it descriptive _and_ actionable: for every failing key, name the canonical key, the Zod issue, the field's description and example (pulled from metadata), the exact spellings of every source that was checked, and a concrete fix. Fail fast, fail once, fail readably—no fixing one missing variable per run.

```
✖ Environmentalist could not resolve configuration for "bowowwow" (2 problems)
  anthropicApiKey — required, but not found
    Anthropic API key used for model calls.
    Checked:  env ANTHROPIC_API_KEY · flag --anthropic-api-key · .env · bowowwow.config.ts (/repo) · ~/.bowowwow
    Fix:      export ANTHROPIC_API_KEY=sk-ant-… , pass --anthropic-api-key=…, or add
              anthropicApiKey to bowowwow.config.ts
    Docs:     https://docs.anthropic.com/…
  port — expected number, received "three thousand"
    Port the server binds to.
    Source:   env PORT (= "three thousand")
    Fix:      set PORT to an integer (e.g. 3000)
```

Every line there is generated from the schema plus its metadata—no hand-written error strings per field, so the errors stay in sync as the schema changes. For callers who don't want throwing, `environmentalist.safe(options)` (and `safeSync`) returns Zod's `{ success, data, error }` result instead. Secrets are redacted wherever they'd otherwise leak: the bad `port` value is shown because it helps, but an invalid `anthropicApiKey` value would be masked.

## Source provenance and debugging

The returned object carries a non-enumerable provenance map so "why is this value what it is?" is always answerable. Expose it behind a symbol to keep it off the typed surface:

```ts
import { SOURCES } from '@lostgradient/environmentalist';
environment[SOURCES].anthropicApiKey;
// → { source: 'env', location: 'ANTHROPIC_API_KEY' }
environment[SOURCES].mode;
// → { source: 'project-config', location: '/repo/bowowwow.config.ts' }
```

Setting `DEBUG=environmentalist` (or an `onResolve` hook) logs the full resolution table—each key, its winning source, and the layers that were considered. Secret values are redacted in this output.

## Secret redaction

Mark a field as secret with Zod v4 metadata, and Environmentalist treats it as radioactive:

```ts
z.object({
  ANTHROPIC_API_KEY: z.string().meta({ secret: true }),
});
```

Ship a `secret()` helper (`secret(z.string())` === `z.string().meta({ secret: true })`) for brevity. Secret keys are redacted in thrown error messages, in the `DEBUG` / provenance output, and in the object's `util.inspect.custom` and `toJSON` representations—so `console.log(environment)` or a crash dump never leaks a key. The _value_ is still readable via normal property access; only serialized/logged representations are masked.

## Metadata, registries, and documentation

Zod v4 ships a real metadata system—`.describe()`, `.meta()`, and first-class `z.registry()`—and Environmentalist leans on it hard, because config is exactly the place where a schema should double as its own documentation. Everything that needs to describe a field reads from one source of truth.

You attach metadata two ways: the global registry via `.meta()`/`.describe()`, or Environmentalist's own typed `registry` for the fields it understands.

```ts
import { z } from 'zod';
import { environmentalist, secret } from '@lostgradient/environmentalist';
const schema = z.object({
  ANTHROPIC_API_KEY: secret(
    z.string().meta({
      description: 'Anthropic API key used for model calls.',
      example: 'sk-ant-…',
      docs: 'https://docs.anthropic.com/…',
    }),
  ),
  DATABASE_URL: z.string().meta({ env: 'DATABASE_URL' }), // force the exact env name
  port: z.coerce.number().default(3000).meta({
    description: 'Port the server binds to.',
  }),
});
```

Recognized metadata keys: `description`, `example`, `docs` (a URL), `deprecated`, `secret` (redaction), plus two per-field source overrides—`env` forces a specific environment-variable name (ignoring the derived casing and any `envPrefix`), and `flag` forces a flag name or alias. That `env` override is what lets you bind to a variable you don't control—`DATABASE_URL` that has to stay exactly `DATABASE_URL`—without contorting the whole schema. `secret()` is just sugar for registering `{ secret: true }`. The typed `registry` export gives you compile-time checking on these keys; plain `.meta()` on the global registry works too and is read as a fallback.

That one metadata source powers everything downstream: **actionable errors** (description, example, and docs URL print in the thrown message), **JSON Schema** (descriptions and examples flow through `z.toJSONSchema` untouched), **`.env.example` and config scaffolding** (each key becomes a commented line with its description and example), and **`--help` / `environmentalist print`** (the same descriptions annotate the resolved table). Write the docs once, on the schema; everything else is generated from it.

## JSON Schema export and scaffolding

Two DX affordances built on the same Zod schema:

- **JSON Schema export.** `environment.toJSONSchema()` (and a standalone `toJSONSchema(schema)`) emits a JSON Schema via Zod v4's native `z.toJSONSchema`, carrying descriptions and examples from the metadata above. Drop it next to a JSON config file with `"$schema": "./bowowwow.schema.json"` for editor autocomplete, or use it to generate a `.env.example`.
- **`initialize` scaffolding.** `environmentalist.initialize({ name, schema, format })` writes a starter config file (`bowowwow.config.ts` by default, or `.json`/`.toml`/`.yaml`) with every key stubbed, defaults filled in, each key's description and example emitted as comments, required keys flagged, and secret keys left blank. It can also emit a `.env.example` derived from the schema. This is what makes a fresh checkout self-documenting.

Provide `defineConfig` for typed config files:

```ts
// bowowwow.config.ts
import { defineConfig } from '@lostgradient/environmentalist';
export default defineConfig({ mode: 'production' });
```

## Watch mode and reactivity

Config isn't always static. A `.env` file changes, someone edits the `userData` config, a feature flag flips in `localStorage`. `environmentalist.watch()` re-resolves on a schedule and hands you the change through whichever interface fits your code—an event, an async iterator, or a subscription a framework can bind to.

```ts
const watcher = environmentalist.watch({ name: 'bowowwow', schema, interval: 1000 });
await watcher.ready; // first resolution done
watcher.current; // latest valid Environment<S>, always current
watcher.on('change', ({ environment, previous, changes }) => {
  // changes: [{ key: 'mode', from: 'development', to: 'production', source: 'dotenv' }]
});
watcher.on('error', (err) => {
  /* EnvironmentalistError from an invalid reload */
});
for await (const environment of watcher) {
  // yields the new snapshot on every change
}
await watcher.close(); // or: await using watcher = environmentalist.watch(…)
```

Detection is **native-first, chosen per source**. The watcher looks at which sources actually fed the resolved config—the same provenance it already tracks—and for each one that has a native change signal it subscribes to that: `fs.watch` for config and `.env` files on Node, the `storage` event for `localStorage` in the browser. Only the sources with no native signal fall back to polling—env vars, and same-tab `localStorage` writes (which don't fire `storage`). When any signal fires it re-runs the full resolution and deep-equals against the last snapshot, emitting only on a real change; the diff is computed against the provenance map, so each change tells you both what a value became and which source now wins it. `strategy` defaults to `'auto'` (this native-first behavior); set `'poll'` to force polling everywhere, for a source a native watcher can't see (a network mount, a synthetic FS).

**Polling never blocks.** A poll tick is scheduled on the platform's idle scheduler—`requestIdleCallback` in the browser, `scheduler.postTask` or `setImmediate` on Node, `setTimeout` as the universal floor—so re-resolution runs when the main thread or event loop is actually free rather than on a hard timer that competes with your app's work. `interval` sets the cadence; the idle scheduler picks the moment within it.

If a reload fails validation, the watcher does _not_ tear down or hand you a broken object. It keeps the last-good `current`, emits an `error` event with the aggregated `EnvironmentalistError`, and keeps polling—so a fat-fingered `.env` edit doesn't crash a running process, it surfaces and then recovers when the file is fixed.

Two properties make the framework bindings cheap. Every change produces a new frozen object, and when nothing changed `current`/`getSnapshot()` return the _same reference_—that stability is what keeps React from looping. And because config is _state_, not a message stream, the async iterator coalesces: a slow consumer always gets the latest snapshot and never a backlog of stale ones. (Want every discrete transition? The `change` event fires for each.)

### Framework bindings

The watcher exposes the two primitives every UI framework wants: `subscribe(cb)` (returns an unsubscribe, fires on change) and `getSnapshot()` (returns `current`). That pair is deliberately the shape of both React's `useSyncExternalStore` and Svelte's store contract, so the wrappers are a few lines and ship as optional subpaths.

React—built on `useSyncExternalStore`, so it's concurrent-safe and SSR-friendly (`getServerSnapshot` returns the server-resolved value):

```tsx
import { useEnvironment } from '@lostgradient/environmentalist/react';
function StatusBar() {
  const env = useEnvironment(watcher);
  return <span>{env.mode}</span>;
}
```

Svelte—the watcher already satisfies the store contract, and the subpath adds a Svelte 5 rune wrapper:

```svelte
<script>
  import { createEnvironment } from '@lostgradient/environmentalist/svelte';
  const env = createEnvironment(watcher); // rune-backed; env.current is reactive
</script>
<span>{env.current.mode}</span>
```

`react` and `svelte` are optional peer dependencies; the core watcher has no framework knowledge and behaves identically in a plain `for await` loop, a Node service, or a worker.

## Options reference

```ts
interface EnvironmentalistOptions<S extends z.ZodObject> {
  name: string; // required — drives file names and home paths
  schema: S; // required — a Zod object schema
  cwd?: string; // where discovery starts (default: process.cwd())
  root?: string; // hard stop for upward traversal
  stopAt?: string | string[]; // marker files that define the workspace root
  modeKey?: string; // key that selects the .env mode (default: 'mode')
  envPrefix?: string; // scope env-var lookups (default: none)
  env?: Record<string, string>; // env source (default: process.env)
  argv?: string[]; // flag source (default: process.argv)
  aliases?: Record<string, string>; // short-flag → canonical key
  search?: string | URL | URLSearchParams; // URL query source (browser: window.location.search)
  dotenv?: boolean | DotenvOptions; // load .env cascade (default: true)
  coerce?: boolean; // auto-coerce string sources (default: true)
  loader?: 'auto' | 'bun' | 'jiti' | ConfigLoader; // TS/JS config loader (default: 'auto')
  sources?: SourceSpec[]; // override/reorder/extend the resolution chain wholesale
  exclude?: SourceName[]; // drop specific built-in sources by id, keep the rest
  onResolve?: (trace: ResolutionTrace) => void; // provenance/debug hook
}
```

The `sources` array is the extensibility seam: reorder the built-in sources, drop ones you don't want, or add a custom async source (a function returning a partial config plus a `location` label for provenance). It's also the seam the browser adapter and future remote sources plug into. Watch mode layers `interval`, `strategy`, `signal`, `emitInitial`, and `equals` on top of these—see Watch mode. Everything else is a convenience over sensible defaults.

Each built-in source has a stable **id**: `flags`, `search-params`, `env`, `dotenv`, `project-config`, `package-json`, `user-dotfile`, `xdg-config`, `home-config`, and `defaults` on Node; `search-params`, `injected-global`, `local-storage`, `import-meta-env`, and `defaults` in the browser. Those ids are exactly what the `SOURCES` provenance map reports and what `exclude` names—`exclude: ['env', 'dotenv']` keeps the whole default chain minus those two. That's the lightweight path when you want the-defaults-except-one, versus `sources`, which replaces the chain wholesale. (`defaults` can be excluded too, to force every key to be supplied explicitly.)

## Public API surface

```ts
// Async (default) — required for runtime .ts config on plain Node
environmentalist(options): Promise<Environment<S>>
environmentalist.safe(options): Promise<SafeResult<S>>
// Sync escape hatch — supports env, flags, .env, and .json/.toml/.yaml/
// precompiled .js/.mjs. Loads .ts too when running under Bun.
environmentalist.sync(options): Environment<S>
environmentalist.safeSync(options): SafeResult<S>
// Watch — a Watcher that is BOTH an event emitter and an AsyncIterable
environmentalist.watch(options & WatchOptions): Watcher<S>
interface Watcher<S> extends AsyncIterable<Environment<S>>, AsyncDisposable {
  readonly current: Environment<S>;          // latest valid snapshot
  readonly ready: Promise<Environment<S>>;   // first resolution settles
  on(e: 'change' | 'error' | 'close', cb): this; off(…); once(…);
  subscribe(cb: (env: Environment<S>) => void): () => void;  // store contract
  getSnapshot(): Environment<S>;             // React useSyncExternalStore
  getServerSnapshot?(): Environment<S>;      // SSR
  close(): Promise<void>;
}
// Tooling (also exposed as CLI subcommands — see below)
environmentalist.initialize(options): Promise<void>
toJSONSchema(schema): JSONSchema
// Electron / IPC
toPublic(environment): PublicEnvironment<S>   // strips secret-marked fields
// Helpers & types
defineConfig<T>(config: T): T                 // parameterize as defineConfig<Env> for strict keys
secret<T extends z.ZodType>(schema: T): T      // sugar for .register(registry, { secret: true })
registry: EnvironmentalistRegistry             // Zod registry: secret/example/docs/env/flag metadata
SOURCES: unique symbol                         // environment[SOURCES] → provenance map
SCHEMA: unique symbol                          // environment[SCHEMA] → the source Zod schema
class EnvironmentalistError extends Error
type Environment<S> = Readonly<CamelCasedPropertiesDeep<z.output<S>>>
  & { readonly [SOURCES]: SourceMap<S>; readonly [SCHEMA]: S };
// Types-only entry for renderer / IPC consumers (no runtime import):
//   import type { Environment } from '@lostgradient/environmentalist/types';
```

`Environment<S>` is frozen (`Object.freeze`) so nothing mutates the resolved config after the fact, camelCase-keyed, and built from the schema's **output** type. Export subpaths: `.` (runtime; resolves to the browser adapter under the `browser` condition), `./types` (types-only, for renderer/IPC consumers), `./cli`, `./react`, and `./svelte`—so the runtime core stays importable without dragging in the TypeScript compiler or any framework.

## Type safety

The whole reason you hand Environmentalist a Zod schema is that what comes back is typed. But "typed" hides some sharp edges in this design, so here's how each one is handled.

**One `ZodType` identity.** `zod` is a peer dependency, so the schema you construct and the schema the library validates against are the same class from the same module instance. Two copies of Zod produce structurally-similar-but-nominally-different types, and inference quietly rots to `unknown` at the seams. Single copy, non-negotiable.

**Output type, not input type.** The resolved `environment` reflects Zod's _output_ type: `.default()` applied, `.transform()` run, coercion done. So the return type is built from `z.output<S>`, never `z.input<S>`. The moment a field has a default or a transform, `z.input` would show it as optional or pre-transform and the object you actually hold wouldn't match.

**The camelCase remap runs twice—and the two copies must agree.** At runtime the keys go through `change-case`; at compile time they go through a `CamelCasedPropertiesDeep` mapped type. Two independent implementations of one function, and if they ever disagree the types are lying. They disagree most easily on all-caps segments (`ANTHROPIC_API_KEY`), embedded acronyms (`AWSRegion`, `OAuthToken`), leading/trailing underscores, and digits (`s3Bucket` vs `s3bucket`). The mitigation is a property test that fuzzes a large corpus of keys through both transforms and asserts identical output; a key shape that can't be represented consistently is rejected at construction rather than silently mistyped.

**Deep, not shallow.** Nested keys (`SERVER__PORT`, `--server.port`) produce nested objects, so the remap type is the _deep_ variant—a shallow one would leave `server.PORT` uncased in the type while the runtime cased it.

**Collisions are a runtime throw.** `ANTHROPIC_API_KEY`, `anthropic-api-key`, and `anthropicApiKey` all collapse to one canonical key. The type system can't stop two schema keys from colliding (the mapped type just merges them, last-wins), so Environmentalist detects collisions when it builds the resolver and throws an `EnvironmentalistError` naming the offenders. Fail at construction, not at 3am.

**Object mode.** `strip` (the default) and `strict` object schemas map cleanly. `.passthrough()` and `.catchall()` introduce an index signature the deep remap can't meaningfully case, so v1 rejects those at construction with an explanatory error rather than half-typing the result.

**Where the one unavoidable assertion lives.** Every source contributes a partial, `unknown`-ish blob, so the merge is loose by nature. The entire type guarantee collapses onto a single `schema.safeParse`—that's the one place an assertion happens, and the schema justifies it. No `as any` threaded through the loaders, the merge, or the coercion. If you're auditing type safety, that parse is the line to read.

**Tightened option types.** `aliases` values and `modeKey` are constrained to `keyof Environment<S>` (the canonical camelCase keys), so a typo in an option is a compile error, not a silent no-op.

**`defineConfig` is strict; raw files are forgiving.** This resolves the tension from the forgiving-casing decision. Author a TS config through `defineConfig<Env>` and you get the strict, canonical-camelCase, autocompleted input type (`DeepPartial<CamelCasedPropertiesDeep<z.input<S>>>`)—typos caught, keys suggested. The any-casing tolerance stays a _runtime_ convenience for hand-written JSON/TOML/YAML and untyped objects. Opt into `defineConfig` and you trade casing freedom for compile-time safety, which is the right default for a `.ts` config.

All of this gets verified with type-level tests (`expect-type` or `tsd`) alongside the runtime suite—the acceptance criteria turn each into a checkbox.

## Command-line interface

Environmentalist ships an `environmentalist` bin that reuses the same runtime-aware loader the library uses. It hosts the tooling as subcommands:

- `environmentalist types <entry>` — generate a concrete TypeScript type for the resolved environment (the headline feature below).
- `environmentalist initialize` — scaffold a config file and `.env.example`.
- `environmentalist schema <entry>` — emit JSON Schema from the schema.
- `environmentalist print <entry>` — resolve the environment and print the provenance table, secrets redacted, descriptions from metadata attached. The debugging command.

### `environmentalist types` — schema-to-type generation

Point it at a module, it finds the schema, and it writes a concrete, materialized TypeScript type for the resolved (camelCase, output) environment. The value is a _portable, flat_ type: no dependency on the `CamelCasedPropertiesDeep` machinery and no runtime import required to consume it. That makes it the natural IPC contract for the Electron split below, and a clean way to publish or share the config type.

Locating the schema: the CLI reads a named export (`--export environment`, default tries `environment`, then `schema`, then the default export) and accepts either a Zod schema (`ZodType`), an Environmentalist result (the schema is recovered through the `SCHEMA` back-reference symbol the library attaches to every resolved object), or the options object passed to `environmentalist`. If nothing matches, it falls back to statically locating the `environmentalist({ schema })` call with ts-morph and reading the `schema` property.

Two generation strategies:

- **Runtime (default).** Load the module with the runtime-aware loader, grab the real Zod schema, and emit the type from it (schema → materialized TS, reusing the `z.toJSONSchema` path plus a Zod→TS printer built with ts-morph). Most accurate—honors defaults, transforms, and the input/output distinction.
- **`--static`.** Never execute the module. Use ts-morph and the TypeScript type checker to extract and expand the inferred type in place, then apply the camelCase remap. Safe for entry files with import-time side effects (an Electron `main.ts` that opens a window), at the cost of not seeing runtime-only refinements.

Output modes—the `--out <file>` extension drives it (or an explicit `--format`):

- **Declaration file** (`.d.ts`): ambient/exported declarations, zero runtime—`export type BowowwowEnvironment = { mode: string; anthropicApiKey: string }`. Add `--augment` to emit a module augmentation instead, so `Environment<'bowowwow'>` resolves globally.
- **Exported type in a `.ts` module**: a normal `export type <Name>Environment = { … }` that other code imports the usual way.

Other flags: `--type-name <Name>` (default derived from `name` → `BowowwowEnvironment`), `--kind input|output` (default `output`; `input` emits the config-author partial), `--watch` (regenerate on change), and `--sources` (also emit the typed provenance map).

ts-morph pulls double duty: the extractor in `--static` mode, and the code _author_ in both modes—it builds and formats the output AST so the generated file is always valid and consistently formatted. The generated type is also a third consistency check on the camelCase transform: an acceptance test asserts the CLI output is mutually assignable with the library's inferred `Environment<S>` across a fixture set. If the generator and the mapped type ever drift, that test fails.

## Electron and Electrobun

Environmentalist is a Node/Bun filesystem-and-process tool, and desktop apps have a process model that breaks most of its default assumptions. Here's what changes.

**Resolve in the main process only.** Electron's renderer (with the secure defaults—`contextIsolation: true`, `nodeIntegration: false`) has no `fs`, no real `process.env`, no directory traversal. Electrobun's webview is the same story against its Bun main process. So resolution happens once in the main/Bun process at startup; the renderer never runs the file/env resolution. The renderer can still use the browser adapter (below) to read its own injected or `localStorage` config, but anything touching secrets, files, and env resolves once in main.

**Know where desktop apps actually store config.** A packaged app doesn't keep config next to a `.git` root; it uses the OS's per-user application-data directory, which Electron exposes as `app.getPath('userData')` (`<appData>/<productName>`) and where `electron-store` writes `config.json`. Environmentalist should check and parse that location. The defaults across platforms:

| OS      | `appData` base                    | Typical `userData` (app "Bowowwow")        |
| ------- | --------------------------------- | ------------------------------------------ |
| macOS   | `~/Library/Application Support`   | `~/Library/Application Support/Bowowwow`   |
| Windows | `%APPDATA%` (Roaming)             | `C:\Users\<user>\AppData\Roaming\Bowowwow` |
| Linux   | `$XDG_CONFIG_HOME` or `~/.config` | `~/.config/Bowowwow`                       |

Get the directory two ways. The **exact** way—pass the real `app.getPath('userData')` in (via `cwd`/`sources`) so it honors the app's `productName`, any `app.setPath('userData', …)`, and portable-mode overrides; this is the recommended path because only Electron knows for sure. The **electron-free** way—an `electron: true` option (or an exported `electronPaths(appName)` helper) reproduces the table above from `os`/`process.env` for when the library runs somewhere Electron can't be imported (the `types` CLI, tests, a preload before `app` is ready). In that directory it looks for `$name.config.*` and parses `electron-store`'s `config.json` (and `<name>.json`) format, so an app already using electron-store is picked up with no migration.

**Ship the resolved config to the renderer over IPC, secrets stripped.** Expose only what the UI needs via `contextBridge` / Electrobun RPC. Because secrets are marked in the schema, the library provides `toPublic(environment)`, which returns a new object with every `secret`-marked field omitted—safe to send across the boundary. Secrets stay main-side. The resolved object is a frozen plain object and structured-clone-serializable, with two caveats to document: the `SOURCES`/`SCHEMA` symbols don't survive structured clone (fine—provenance stays in main), and non-clonable field types (class instances, functions produced by a `transform`) won't cross IPC.

**Env vars and flags are unreliable for GUI launches.** A double-clicked app doesn't inherit the user's shell environment—`process.env` is nearly empty and there are no meaningful CLI flags. So the practical precedence in a packaged app leans on file sources: the `userData` config file and `.env` files do the real work, with env/flags as a dev-time convenience. Document this so nobody ships an app that reads `ANTHROPIC_API_KEY` from a variable that's never set.

**Don't runtime-transpile `.ts` config in production.** Loading `.ts` from inside an `.asar` archive with jiti is fragile, and you wouldn't ship uncompiled config anyway. In packaged apps, use `.json`/precompiled config and the sync path; keep `.ts` config for development.

**Type the IPC boundary with the generated `.d.ts`.** This is where the `types` CLI earns its keep: emit a concrete config type, then have both the main handler and the renderer `import type` _that file only_—the renderer gets a fully-typed config object with zero runtime import of the library, so its bundler never tries to pull `fs`/`jiti` into the browser context. The `@lostgradient/environmentalist/types` subpath carries the shared helper types for the same reason.

Electrobun specifically: because it's Bun-based, the loader's native-Bun path applies directly (native `.ts`, and the sync path can load `.ts` under Bun), it stores app data under the same platform conventions (pass its data directory in the same way), and the same main-process/webview split and RPC guidance holds.

## Browser and cross-runtime support

Everything above assumes files and `process.env`, which the browser doesn't have. But the resolution _engine_—canonical keys, per-key precedence merge, coercion, validation, provenance, redaction, watch—is platform-neutral. Only two things are platform-specific: the **sources** (where values come from) and the **config loader** (how a `.ts` file gets executed). So Environmentalist is structured as a neutral core plus **platform adapters selected by export condition**, and the browser is just another adapter.

Import the package under the `browser` export condition—bundlers pick it up automatically; Vite, webpack, and esbuild all honor it—and you get a build with no `fs`, `os`, `path`, `jiti`, or `dotenv` in the graph, only browser-safe sources. Zod and `change-case` are already isomorphic, so the core comes along unchanged.

Browser sources, highest priority first:

1. **URL query params** — the shared `search-params` source, reading `window.location.search` by default; the browser analog of CLI flags (per-navigation, explicit). Ignored for `secret` keys by default, since URLs leak into history and logs.
2. **Injected global** — `window.__BOWOWWOW__`, an object a server inlines into the HTML for SSR/hydration. This is the browser version of the Electron IPC hand-off: the server resolves the real config and injects the _public_ subset.
3. **`localStorage`** — a JSON blob under `environmentalist:$name`; the natural home for user overrides and dev toggles, and it persists across sessions.
4. **Build-time env** — `import.meta.env` (Vite) or a bundler `define`, for values baked in at build time.
5. **Schema defaults** — the floor, same as everywhere.

The order is a sensible default and, like the Node chain, fully reorderable through `sources`. Watch mode works here too and stays native-first: the `storage` event catches cross-tab `localStorage` changes instantly, with idle-scheduled polling covering same-tab writes.

Two hard constraints, both worth stating loudly. There's **no `.ts` config in the browser**—no jiti, no filesystem—so config is data (JSON in storage, an injected object), and `defineConfig` and the file loaders are Node/Bun only. And **the browser keeps no secrets**: anything shipped to the client is public, full stop. Redaction still scrubs logs, but the real rule is the Electron rule—resolve secrets server- or main-side and hand the browser only the `toPublic()` subset. With that, the Electron renderer stops being a special case: it's the browser adapter receiving an injected public config, which is exactly the recommended renderer pattern from the previous section.

## Packaging and tooling

ESM-only. `zod` is a `peerDependency` (`^4`) so there's exactly one copy of Zod shared with the consumer's schema—no dual-instance `instanceof` surprises. Bundled `.d.ts`. Runtime targets are Node ≥ 20 and Bun.

- **Build:** `tsdown` (or `tsup`), ESM output plus types. (This repo already has a Bun.build-based `scripts/build.ts` — extending that is acceptable as long as the artifact/exports contract below holds.)
- **Test:** `bun test`.
- **Types:** `tsc --noEmit`.
- **Package correctness:** `publint` and `@arethetypeswrong/cli`.

Runtime dependencies (core): `change-case` (ESM v5, isomorphic), plus the Node-only source deps `dotenv`, `dotenv-expand`, `jiti`, `toml`, `yaml`—all confined to the Node adapter so the `browser` condition tree-shakes them out. Peer: `zod@^4` (isomorphic). Optional peers: `react` and `svelte`, used only by their respective subpaths. The CLI adds `ts-morph` (which carries the TypeScript compiler); keep it out of the core runtime by scoping it to the `environmentalist/cli` bin so importing the library never pulls in the compiler. Export subpaths and conditions: `.` (runtime, with a `browser` condition selecting the browser adapter build), `./types` (types-only), `./cli`, `./react`, `./svelte`.

### One build, multiple entries

There's no separate build pipeline per runtime. The only split that matters is Node-family vs browser; everything else is runtime detection or bundler resolution. A single build emits a handful of entry artifacts from shared source—`index.node.js`, `index.browser.js`, `cli.js`, `react.js`, `svelte.js`—plus one shared `.d.ts` set (the public `Environment<S>` type is identical across runtimes; only which sources exist at runtime differs). A thin platform module resolved per entry (`platform.node` vs `platform.browser`) swaps `fs`/`jiti`/`fs.watch`/`setImmediate` for the browser's storage-event/`requestIdleCallback` set, so no Node built-in ever lands in the browser artifact.

The `exports` map routes conditions to those two artifacts:

```jsonc
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "browser": "./dist/index.browser.js",
      "node": "./dist/index.node.js",
      "bun": "./dist/index.node.js",
      "default": "./dist/index.node.js",
    },
    "./types": "./dist/types.d.ts",
    "./cli": "./dist/cli.js",
    "./react": "./dist/react.js",
    "./svelte": "./dist/svelte.js",
  },
  "bin": { "environmentalist": "./dist/cli.js" },
}
```

That covers every runtime with two artifacts. Node, Bun, Electron main, and Electrobun main resolve to the Node artifact—Bun-vs-Node (native `.ts`, sync `.ts` loading) is a runtime branch (`typeof Bun`), not a build, so the `bun` condition just points at the same file. Browser, Electron renderer, and Electrobun webview resolve to the browser artifact via the `browser` condition. So `electron` isn't a build target and there's no `electron` condition to maintain, and because the package is ESM-only there's no CJS twin and therefore no dual-package hazard.

What fans out is testing, not building: the same code runs on Node, on Bun, and in a DOM environment (jsdom / happy-dom) to prove the platform shims and the browser source set. That's a test matrix over one build—the acceptance criteria already pin the no-`fs`-in-the-browser-graph check.

> [!WARNING] Trust boundary
> Loading a `.ts`/`.js` config file _executes code_. That's fine for a project file you committed, but the home-directory sources (`~/.$name`, `~/.environmentalist/$name`) execute code owned by the user, not the project. This is standard for config tools, but document it: restrict executable config to trusted locations, and offer a `loader: 'json-only'`-style lockdown for environments that shouldn't run arbitrary config code.

## Non-goals and future work

Explicitly out of scope for v1: **remote sources** (Vault, AWS SSM, Doppler, 1Password)—though the `sources` seam is designed to make these addable later; **encrypted secrets at rest** (dotenvx-style); **schema migrations / versioning**; **`.passthrough()` / `.catchall()` object schemas** (rejected at construction until there's a real use case for the index-signature type); **server-pushed config** (websocket/SSE live config from a control plane—watch mode polls local sources, it doesn't subscribe to a remote); and **CJS output**. Watch mode and browser support are _in_ scope (above), so they've moved off this list.

## Parallel implementation tracks

The work decomposes into tracks that can be built by separate agents against a shared `types.ts` contract. Each track ships with its own tests and must leave `bun test` and `tsc --noEmit` green.

- **Track A — Key model & types.** `change-case` round-trip utilities (canonicalize, and derive constant/kebab/camel spellings), the `CamelCasedPropertiesDeep` type util, key normalization for incoming source keys, and the property test proving the runtime and type-level transforms agree. _Owns:_ `src/keys.ts`, `src/types.ts`.
- **Track B — Source loaders (Node adapter).** Env reader (prefix, `__` nesting), `.env` cascade (`dotenv` + expand + mode-specific ordering), config-file discovery + the runtime-aware loader, home-directory + XDG + `package.json` sources. Coordinate the source-interface shape with Track J. _Owns:_ `src/sources/node/*`.
- **Track C — CLI flags & URL search params.** The flag parser: `=`/space forms, `--no-` negation, aliases, repeats→arrays, dot-path nesting, `--` terminator; plus the `search-params` source over the same parser (accepting `URL`/`URLSearchParams`/string, with `secret`-key omission). _Owns:_ `src/flags.ts`, `src/search-params.ts`.
- **Track D — Merge & coercion engine.** Source-chain assembly with `exclude` filtering and stable source ids, per-key precedence merge, deep merge for nested objects, string→schema coercion, the two-pass mode resolution, and construction-time guards (key-collision throw, `.passthrough()`/`.catchall()` rejection). _Owns:_ `src/resolve.ts`.
- **Track E — Validation, errors, provenance, secrets, metadata.** Aggregated `safeParse` + the descriptive/actionable `EnvironmentalistError`, the `registry` and metadata plumbing (description/example/docs/env/flag), the `SOURCES` provenance map + `SCHEMA` back-reference, `DEBUG`/`onResolve` tracing, secret redaction in errors/inspect/toJSON, and `toPublic`. _Owns:_ `src/validate.ts`, `src/redact.ts`, `src/metadata.ts`.
- **Track F — DX tooling.** `toJSONSchema`, `initialize` scaffolding, `defineConfig`, `secret`, the `registry` export. _Owns:_ `src/tooling/*`.
- **Track G — Packaging & build.** The single build emitting the Node + browser entries (plus `cli`/`react`/`svelte`), the per-entry platform shim, the `exports` conditions map, peer/optional-peer wiring, the cross-runtime test matrix (Node / Bun / DOM), and `publint`/`attw` gates. _Owns:_ `package.json`, build + CI config.
- **Track H — CLI & type generation.** The `environmentalist` bin and subcommands (`types`, `initialize`, `schema`, `print`), both generation strategies (runtime + `--static` via ts-morph), the Zod→TS printer, and the Electron `userData` path resolver + electron-store parsing. _Owns:_ `src/cli/*`, `bin/`.
- **Track I — Watch & reactivity.** Polling + native (`fs.watch` / `storage`) change detection, the diff-against-provenance, the emitter + async-iterator `Watcher` (coalescing, reference-stable snapshots, keep-last-good on error), and the `subscribe`/`getSnapshot` store contract. Plus the `react` and `svelte` wrapper subpaths. _Owns:_ `src/watch/*`, `src/react.ts`, `src/svelte.ts`.
- **Track J — Cross-runtime adapters.** The neutral-core / platform-adapter split, the shared source interface, browser sources (query params, injected global, `localStorage`, `import.meta.env`), and the `browser` export-condition wiring. _Owns:_ `src/sources/browser/*`, `src/platform.ts`.

Sync points: Track A and the shared `types.ts` land first (everything imports them). Track D depends on B and C. The top-level `environmentalist()` that wires D → E → F is assembled after D and E are green. Track H builds last, on the finished `environmentalist()` plus the metadata and `SCHEMA` back-reference from E. Track I builds on the resolved core (D/E). Track J refactors the source layer behind the platform boundary, so B and J share the source interface and must land it together before either finalizes.

## Acceptance criteria

Each item is independently verifiable—a test passes or a command exits `0`. Implement test-first: write the failing test, implement until green, then move on. Nothing is done until `bun test`, `bunx tsc --noEmit`, `bunx publint`, and `bunx @arethetypeswrong/cli --pack` all exit `0`.

Key model and typing:

- [ ] `environment.anthropicApiKey` is defined when the schema key is `ANTHROPIC_API_KEY`; `environment.ANTHROPIC_API_KEY` is `undefined`.
- [ ] A config file spelling a key `anthropicApiKey`, `ANTHROPIC_API_KEY`, or `anthropic-api-key` resolves to the same value (three tests, same expectation).
- [ ] `tsc --noEmit` proves the return type exposes camelCase keys: a test file reading `environment.ANTHROPIC_API_KEY` fails type-check; reading `environment.anthropicApiKey` passes.
- [ ] The returned object is frozen: `Object.isFrozen(environment) === true`.

Resolution order (each asserts the documented winner with the same key set in multiple sources):

- [ ] A `--anthropic-api-key` flag beats an `ANTHROPIC_API_KEY` env var.
- [ ] A real env var beats a value in `.env`.
- [ ] `.env.$mode.local` beats `.env.local` beats `.env.$mode` beats `.env`.
- [ ] A nearer `bowowwow.config.ts` beats a workspace-root one.
- [ ] A project config file beats `~/.$name`, which beats `~/.config/$name/config.*`, which beats `~/.environmentalist/$name`, which beats a schema `.default()`.
- [ ] Per-key composition: env supplies one key and a config file supplies another; both appear in the result.
- [ ] Traversal stops at the workspace-root marker and does not read config files above it.

Sources:

- [ ] `--key=value`, `--key value`, `--no-key`, repeated flags (→array), an alias, and `--server.port=3000` (→nested) each parse as specified (six tests).
- [ ] `envPrefix: 'BOWOWWOW'` makes `mode` read `BOWOWWOW_MODE` and ignore bare `MODE`.
- [ ] `search: '?anthropic-api-key=sk-x&tag=a&tag=b'` resolves `anthropicApiKey` and `tag: ['a','b']`; in a jsdom test the same values resolve from `window.location.search` with no `search` option.
- [ ] A `secret`-marked key present in the URL search params is ignored by default (its value does not appear in the result).
- [ ] `exclude: ['env']` drops env-var resolution: a value set only in the environment is absent, while other sources still resolve; the excluded id does not appear in the `SOURCES` map.
- [ ] `exclude: ['defaults']` makes a key with a schema `.default()` fail as required when no other source provides it.
- [ ] `SERVER__PORT=3000` resolves to `{ server: { port: 3000 } }`.
- [ ] `${VAR}` in a `.env` value is expanded.
- [ ] Config files in `.ts`, `.js`, `.json`, `.toml`, and `.yaml` each load and contribute values (five tests).
- [ ] A `$name` key in `package.json` is read as a config source.
- [ ] The two-pass mode resolution: setting `mode` via a flag changes which `.env.$mode` file is loaded (one test proves the pre-pass).

Coercion, validation, secrets, provenance:

- [ ] With `z.number()` and `z.boolean()` fields, string env values coerce to `number`/`boolean` (asserted via `typeof`).
- [ ] `coerce: false` leaves string values as strings.
- [ ] A file source with an already-typed value bypasses coercion unchanged.
- [ ] Two simultaneously-invalid keys produce one thrown `EnvironmentalistError` whose message names both keys.
- [ ] `environmentalist.safe(...)` returns `{ success: false, error }` instead of throwing on the same input.
- [ ] `environment[SOURCES].<key>` reports the correct `source` and `location` for a value that came from env vs. a config file (two tests).
- [ ] A field marked `secret` is masked in the thrown error message, in `JSON.stringify(environment)`, and in `util.inspect(environment)` (three tests), while `environment.theSecret` still returns the real value.

Tooling and packaging:

- [ ] `toJSONSchema(schema)` returns valid JSON Schema (validated against a JSON Schema meta-schema).
- [ ] `initialize` writes a config file that, when read back through `environmentalist`, produces a valid environment.
- [ ] The package is ESM-only and `publint` + `@arethetypeswrong/cli` report no problems.
- [ ] `zod` appears only in `peerDependencies`, not `dependencies`.
- [ ] The library core entry (`.`) imports without pulling `ts-morph`/`typescript` into the module graph.
- [ ] Export resolution routes `.` to the browser artifact under the `browser` condition and to the Node artifact under `node`/`bun`/`default` (assert with a resolver, e.g. `resolve.exports`).

Type safety:

- [ ] Property test: 1,000+ fuzzed keys produce identical output from the runtime `change-case` transform and the `CamelCasedPropertiesDeep` type-level transform.
- [ ] `ANTHROPIC_API_KEY`, `AWS_REGION`, `s3Bucket`, and `oauth2Token` each map to their documented camelCase key in both runtime and type (table test).
- [ ] A field declared with `.default()` is non-optional on the returned `environment` type (proves output-type basis) — asserted with `expect-type`.
- [ ] Two schema keys that camelCase-collide throw `EnvironmentalistError` at construction, message naming both.
- [ ] A `.passthrough()` / `.catchall()` schema throws a clear error at construction.
- [ ] `aliases` with a value that isn't a canonical key fails `tsc --noEmit`.

Metadata and errors:

- [ ] A missing-required-key error message contains the key's `description`, its `docs` URL, the exact env/flag/file spellings checked, and a fix line (assert each substring).
- [ ] An invalid non-secret value appears verbatim in the error; an invalid `secret`-marked value is masked (two assertions, one message).
- [ ] A field with `{ env: 'DATABASE_URL' }` metadata resolves from `DATABASE_URL` even when `envPrefix` is set.
- [ ] `.env.example` / scaffold output contains each key's `description` as a comment.

CLI and type generation:

- [ ] `environmentalist types ./fixture.ts --out out.d.ts` writes a `.d.ts` that `tsc --noEmit` accepts.
- [ ] The generated type is mutually assignable with the library-inferred `Environment<S>` for every fixture (`expect-type`, both directions).
- [ ] The generated type contains `anthropicApiKey`, not `ANTHROPIC_API_KEY`.
- [ ] `--static` runs without executing module side effects: a fixture that writes a sentinel file on import leaves no sentinel after `--static`, but the runtime strategy creates it.
- [ ] Both `--out x.d.ts` and `--out x.ts` (exported type) compile.
- [ ] `--kind input` and `--kind output` differ in the optionality of a defaulted key.
- [ ] The CLI locates the schema via `--export`, via an auto-detected `environmentalist()` call, and via the `SCHEMA` back-reference (three tests).

Electron / Electrobun:

- [ ] `toPublic(environment)` omits every `secret`-marked key, preserves the rest, and its output passes `structuredClone` without throwing.
- [ ] `electronPaths('Bowowwow')` returns the documented `userData` directory for each of macOS, Windows (`%APPDATA%`), and Linux (`$XDG_CONFIG_HOME`/`~/.config`) — asserted per platform.
- [ ] An `electron-store`-style `config.json` placed in the resolved `userData` directory is discovered and parsed into the environment.
- [ ] The generated config `.d.ts` can be `import type`d in a file that does NOT import the library runtime, and `tsc --noEmit` passes.

Watch mode and reactivity:

- [ ] Changing a watched `.env` value fires a `change` event whose `changes` entry names the key, `from`, `to`, and `source`.
- [ ] A file-backed config is watched via `fs.watch` with no polling timer scheduled; an env-var-only config falls back to polling — assert the path taken per source.
- [ ] Poll ticks dispatch through the idle scheduler (`requestIdleCallback` / `scheduler.postTask` / `setImmediate`), verified by stubbing that API — not a bare `setInterval`.
- [ ] After an invalid reload, `current` still equals the last valid environment and an `error` event fired; the watcher is not closed and recovers on the next valid reload.
- [ ] `getSnapshot()` returns the identical reference across ticks when nothing changed (reference stability).
- [ ] Given two rapid changes before a slow consumer reads the async iterator, it observes the newest snapshot and no stale backlog (coalescing).
- [ ] `close()` (and `await using`) stops polling and removes native listeners — no leaked timer or listener (asserted).
- [ ] `useEnvironment` re-renders a React test component on change and not otherwise (render-count assertion).
- [ ] The Svelte wrapper's `current` updates reactively on change (component test).

Browser and cross-runtime:

- [ ] Imported under the `browser` condition, the module graph contains no `fs`/`os`/`path`/`jiti`/`dotenv` (bundle-analysis or import assertion).
- [ ] In a jsdom / happy-dom test, values resolve from `localStorage`, a `window.__BOWOWWOW__` global, and `?key=` query params in the documented precedence.
- [ ] A simulated cross-tab `storage` event fires a watcher `change` in the browser adapter.
- [ ] A `secret`-marked key is absent from the object produced for a simulated browser/renderer context (`toPublic` is the only thing that crosses).
