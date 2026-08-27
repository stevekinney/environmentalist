import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, mock, setSystemTime } from 'bun:test';

// Sentinel so tests can assert the preload actually ran.
(globalThis as Record<string, unknown>)['__BUN_TEST_SETUP_LOADED__'] = true;

// Work around a one-time-per-process Bun 1.4.0 `require()`/`import()` bug:
// the FIRST time a process resolves a freshly created `.ts` file, then
// resolves a second freshly created `.ts` sibling in the same directory, the
// second resolution fails with "Cannot find module ... from ''" even though
// the file exists on disk — every subsequent occurrence in the same process
// succeeds. Several suites under src/sources/node and src/cli create sibling
// temp `.ts` fixtures and load them in the same test run, so whichever test
// happens to run first (order varies under --randomize/--parallel) would
// otherwise fail nondeterministically. Trigger the bug harmlessly here,
// before any real test runs, so the one failure lands on disposable fixtures
// instead of the suite. Filed upstream:
// https://github.com/oven-sh/bun/issues/40585 — remove once fixed.
if (typeof process !== 'undefined' && process.versions?.['bun'] !== undefined) {
  // This entire block is a best-effort workaround, not a correctness
  // requirement: if anything in it throws — including the first `require()`,
  // e.g. because a future Bun release changes this behavior — the warmup
  // must not be able to fail the suite itself.
  try {
    const warmupDir = mkdtempSync(join(tmpdir(), 'environmentalist-bun-warmup-'));
    try {
      const first = join(warmupDir, 'a.ts');
      writeFileSync(first, 'export const A = 1;\n');
      createRequire(pathToFileURL(first).href)(first);

      const second = join(warmupDir, 'b.ts');
      writeFileSync(second, 'export const B = 2;\n');
      try {
        createRequire(pathToFileURL(second).href)(second);
      } catch {
        // Expected on the first occurrence per process; this call is what
        // absorbs the bug so real tests don't hit it.
      }
    } finally {
      rmSync(warmupDir, { recursive: true, force: true });
    }
  } catch {
    // If the warmup itself couldn't run, real tests take the risk of hitting
    // the bug instead — better than aborting the whole run from a preload.
  }
}

afterEach(() => {
  mock.restore();
  setSystemTime();
});
