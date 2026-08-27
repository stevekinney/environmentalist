# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential Commands

### Development

```bash
bun run dev               # Start development with watch mode
bun run build             # Build for production (outputs to dist/)
node ./dist/cli.js --help # Exercise the built CLI under plain Node
```

### Testing

```bash
bun run test          # Serial, 100% coverage enforced — this is the gate (bun test --coverage)
bun test src/watch    # Run tests in specific directory (no coverage unless --coverage is passed)
bun test resolve      # Run tests matching pattern
bun test --watch      # Watch mode
bun test --coverage   # Generate coverage report
bun run test:parallel # Faster local loop: bun test --parallel, no coverage — not the gate
```

Coverage is opt-in per invocation, not global: `bunfig.toml` configures the reporter and the 100% threshold, but only `--coverage` (wired into the `test`/`test:coverage` scripts) turns it on. `bun run test:parallel` is for local iteration speed only — Bun 1.4.0's `--parallel` cross-worker coverage merge is lossy against the 100% threshold, so `test:parallel` omits `--coverage` entirely and CI never runs it; `bun run test`/`test:coverage` (serial) stay the gate.

### Code Quality

```bash
bun run lint             # Check linting errors
bun run lint:fix         # Auto-fix linting errors
bun run typecheck        # TypeScript type checking (src + scripts)
bun run typecheck:test   # TypeScript type checking (test files)
bun run format           # Format all files with Prettier
bun run format:check     # Check formatting without changes
bun run check            # Fast local sanity: format:check + lint + typecheck
bun run validate         # Full gate: format:check + lint + typecheck + typecheck:test + test + build + package:check
```

### Utilities

```bash
bun run clean            # Clean build artifacts (dist/, coverage/, caches)
bun run package:check    # Run publint + @arethetypeswrong/cli on packed tarball
```

### Releasing

Tag-driven and tokenless via npm trusted publishing (OIDC) — there is no `NPM_TOKEN` in this repository.

```bash
npm version patch        # commits and tags vX.Y.Z
git push --follow-tags   # triggers .github/workflows/release.yaml
```

The npm-side trusted publisher is bound to the workflow **filename**, so renaming `.github/workflows/release.yaml` breaks publishing until the npm configuration is updated to match. `NPM_CONFIG_PROVENANCE` belongs in the workflow, not in `publishConfig` — provenance requires a supported CI and would break any local publish.

## Architecture Overview

### Core Design Principles

This repository is the published library `@lostgradient/environmentalist` — a Zod-schema-driven configuration resolver. `README.md` documents the consumer-facing surface; `DESIGN.md` is the original design specification and describes intent, not necessarily current behavior.

1. **Neutral Core, Platform Adapters**: The resolution engine (canonical keys, per-key precedence merge, coercion, validation, provenance, redaction, watch) is platform-neutral. Only the sources and the config loader are platform-specific, selected by export condition. Node-only dependencies must stay behind `src/sources/node/` and `src/platform/node.ts` so the `browser` artifact tree-shakes them out.

2. **One Canonical Key Model**: Every key normalizes to camelCase. The remap runs twice — at runtime via `change-case` (`src/keys.ts`) and at compile time via `CamelCasedPropertiesDeep` (`src/types.ts`). These two must agree; a property test enforces it. Changing either without the other makes the types lie.

3. **Runtime-Neutral Published Code**: `src/` must not use Bun-only runtime APIs (`Bun.file`, `Bun.env`, `Bun.serve`, etc.). Those APIs are fine in `scripts/` and test files, but must not appear in published library output.

4. **One Copy of Zod**: `zod` is a peer dependency and must never move to `dependencies`. Two copies produce nominally different types and inference rots to `unknown` at the seams.

### Key Notes

- **ESM + TypeScript**: Source files are TypeScript modules; build output targets both Node and Bun.
- **Import paths**: Use standard TS/ESM imports; no `@/*` path alias (it leaks into `.d.ts` files).
- **Library output**: One build emits Node, browser, CLI, React, and Svelte artifacts. The `exports` map routes consumers automatically.

### Library Packaging

The build produces:

- `dist/index.node.js` — ESM bundle, `Bun.build target: 'node'`, all deps external
- `dist/index.browser.js` — ESM bundle, `Bun.build target: 'browser'`, all deps external
- `dist/cli.js` — ESM CLI bundle with the `environmentalist` shebang
- `dist/react.js` and `dist/svelte.js` — optional framework entry bundles
- `dist/index.d.ts` — TypeScript declarations (shared)

The `exports` map in `package.json`:

```json
{
  ".": {
    "types": "./dist/index.d.ts",
    "browser": "./dist/index.browser.js",
    "node": "./dist/index.node.js",
    "bun": "./dist/index.node.js",
    "default": "./dist/index.node.js"
  },
  "./types": {
    "types": "./dist/types-entry.d.ts",
    "default": "./dist/types-entry.d.ts"
  },
  "./cli": {
    "types": "./dist/cli/index.d.ts",
    "node": "./dist/cli.js",
    "default": "./dist/cli.js"
  },
  "./react": { "types": "./dist/react.d.ts", "default": "./dist/react.js" },
  "./svelte": { "types": "./dist/svelte.d.ts", "default": "./dist/svelte.js" },
  "./package.json": "./package.json"
}
```

`./types` is types-only (for renderer/IPC consumers with no runtime import). `ts-morph` is an optional dependency scoped to the CLI so importing the library never pulls in the TypeScript compiler.

Package validation runs as part of `validate`: `publint` checks the exports map structure and `@arethetypeswrong/cli` checks type resolution across resolution modes.

### Git Hooks Architecture

Hooks are configured in `lefthook.yml` and implemented as Bun TypeScript files under `scripts/hooks/`:

- **pre-commit** (`lefthook.yml`, piped/sequential): formats staged files with Prettier, runs oxlint --fix on staged files, blocks staged conflict markers, and checks `bun.lock` is staged when `package.json` changes. Fast by design; skipped during merge/rebase.
- **pre-push** (`lefthook.yml`): runs full `bun run validate`; skipped in CI.
- **post-checkout** (`scripts/hooks/post-checkout.ts`): installs deps when `bun.lock` changes; surfaces config changes. Silent when nothing actionable changed.
- **post-merge** (`scripts/hooks/post-merge.ts`): installs/cleans when dependencies or config changed; flags leftover conflict markers. Silent when nothing actionable changed.

Hooks print only on failure (`output: [failure, execution_out]` in `lefthook.yml`), so a clean commit/push stays quiet. The TypeScript hook scripts use `chalk` for color, `change-case` for headings, and Bun's `$` and `Bun.write` for shell/IO.

### Claude Code Hooks

`.claude/settings.json` wires up two project-level Claude Code hooks (scripts in `.claude/hooks/`):

- **format-on-edit** (`PostToolUse` on `Edit`/`Write`): runs `prettier --write --ignore-unknown` on the file Claude just edited, so edits always match the project style and never trip the format gate. Fail-safe — no-ops if Prettier isn't installed yet.
- **protect-env** (`PreToolUse` on `Write`): blocks writes to `.env` / `.env.*` (except `.env.example`) so secrets aren't clobbered. Edit those files manually.

Both scripts exit 0 (no-op) when their dependencies are missing, so a fresh clone never breaks a session. No `.env` file is tracked in this repository — the library reads `.env` files belonging to _consuming_ projects, and any local `.env`/`.env.example` here is gitignored scratch. `protect-env` is a standing guard, not a description of tracked files.

### Source Layout

- `src/types.ts` — the shared contract: `EnvironmentalistOptions`, `Environment<S>`, `SourceName`, `SourceSpec`, and the `SOURCES`/`SCHEMA` symbols. Nearly everything imports it.
- `src/keys.ts` — canonical-key normalization and the per-source casing derivations.
- `src/resolve.ts`, `src/resolve-core.ts`, `src/source-chain.ts` — chain assembly, per-key precedence merge, two-pass mode resolution. `DEFAULT_SOURCE_NAMES` in `source-chain.ts` is the authoritative Node source order.
- `src/validate.ts`, `src/errors.ts`, `src/redact.ts`, `src/metadata.ts` — aggregated validation, the actionable error message, secret redaction, and the Zod metadata registry.
- `src/sources/node/` and `src/sources/browser/` — the platform-specific source implementations.
- `src/watch/` — the watcher; `src/react.ts` and `src/svelte.ts` are thin bindings over `subscribe`/`getSnapshot`.
- `src/cli/` — the `environmentalist` bin. The only place `ts-morph` may be imported.

## Development Patterns

### Adding a Source

1. Add the id to `SourceName` in `src/types.ts`.
2. Implement it under `src/sources/node/` or `src/sources/browser/`.
3. Wire it into the chain in `src/source-chain.ts` (Node) or `src/index.browser.ts` (browser), in precedence order.
4. Cover it in the `exclude` and provenance tests — the id has to appear in the `SOURCES` map and be droppable by `exclude`.
5. Document the id and its precedence position in `README.md`.

### Adding Schema Metadata

Metadata keys are declared in `src/metadata.ts` and consumed by errors, `toJSONSchema`, `initialize` scaffolding, and `environmentalist print`. Adding a key means updating the type, the collector, and every consumer that should honor it.

### Testing Approach

- Tests use Bun's built-in test runner with `describe`, `it`, `expect`.
- Test files are colocated with sources using the `.test.ts` suffix.
- `test/setup.ts` is preloaded by `bunfig.toml` — it resets mocks and system time in `afterEach`. All tests get this automatically.
- Oxlint rules are relaxed for test files. You can use `any`, non-null assertions, and other patterns normally flagged.
- A separate `tsconfig.test.json` provides relaxed TypeScript settings for tests (checked by `bun run typecheck:test`).
- Coverage threshold is 100% for `src/`. Run `bun test --coverage` to see the report.

### Import Organization

Keep imports in this order:

1. Bun built-ins (e.g., `import { file, write } from 'bun'`)
2. Node built-ins (e.g., `import { readFile } from 'node:fs'`)
3. External packages (e.g., `import { z } from 'zod'`)
4. Relative imports (e.g., `./local-module`)

No path alias (`@/*`) — use relative imports everywhere.

## Bun-Specific Considerations

- Always use `bun` commands, not `npm` or `yarn`.
- The lockfile in this repo is `bun.lock`.
- Bun provides native TypeScript execution without precompilation.
- For one-off package execution, use `bun x` for packages already in `devDependencies` rather than `bunx`, which can pull remote versions.

### Prefer Bun Built-ins Over Node

When possible, use Bun's native APIs in `scripts/` and tests. Do not use them in `src/` — published code must be Node-compatible.

| Task          | Use (Bun)                                | Avoid (Node)                     |
| ------------- | ---------------------------------------- | -------------------------------- |
| Read file     | `Bun.file(path).text()`                  | `fs.readFileSync(path, 'utf-8')` |
| Write file    | `Bun.write(path, data)`                  | `fs.writeFileSync(path, data)`   |
| HTTP server   | `Bun.serve()`                            | `http.createServer()` or Express |
| Hashing       | `Bun.hash()` or `new Bun.CryptoHasher()` | `crypto.createHash()`            |
| Spawn process | `Bun.spawn()` or `Bun.$`                 | `child_process.spawn()`          |
| Sleep         | `Bun.sleep(ms)`                          | `setTimeout` with promisify      |
| Environment   | `Bun.env.VAR`                            | `process.env.VAR`                |
| Glob          | `Bun.Glob`                               | `glob` package                   |

When a Bun equivalent doesn't exist or Node's API is more appropriate, use the `node:` prefix for clarity (e.g., `import { join } from 'node:path'`).

### Configuration Notes

- **bunfig.toml**: Configures the `.md` text loader, forces Bun runtime for scripts, sets the isolated install linker, preloads `test/setup.ts`, and sets the coverage reporter and 100% thresholds (coverage collection itself is opt-in per invocation via `--coverage`, not global — see Testing below).
- **TypeScript**: Uses Bun types; Node type libs are not included by default.
- **Oxlint**: Rust-based linter with built-in TypeScript, promise, unicorn, and import plugins. Type-aware rules enabled via `--type-aware --tsconfig ./tsconfig.json`. Test files have relaxed rules.
- **Testing**: `bun run test` (`bun test --coverage`) is the CI gate and enforces 100% coverage. `bun run test:parallel` (`bun test --parallel`, no `--coverage`) runs the same suite for a faster local loop — not gated, because Bun 1.4.0's parallel coverage merge under-reports against this repository's threshold.
- **Install linker**: `bunfig.toml` sets `[install] linker = "isolated"` so local installs and CI use the same `node_modules` layout.
