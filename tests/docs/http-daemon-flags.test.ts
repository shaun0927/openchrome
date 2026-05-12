/// <reference types="jest" />
/**
 * Doc-drift guard for docs/getting-started/http-daemon.md.
 *
 * Imports the check-doc-flags script directly (no shell-out) and asserts that
 * every --flag and OPENCHROME_* env var documented in the page is referenced
 * in src/index.ts. Fails the build if a documented symbol drifts out of sync
 * with the source.
 */

// ts-jest does not understand ESM .mjs imports directly, so we use createRequire
// to load the CommonJS-compatible ESM module via dynamic import inside a
// beforeAll, converting the async result into a synchronous jest variable.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-doc-flags.mjs');

describe('http-daemon doc-drift guard', () => {
  it('every --flag and OPENCHROME_* in http-daemon.md exists in src/index.ts', () => {
    // Shell out to the script so we get the full ESM module without having to
    // configure ts-jest for .mjs interop. The script exits 0 on success, 1 on failure.
    const result = spawnSync('node', [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15000,
    });

    // Print script output so failures are easy to diagnose in CI logs
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }

    expect(result.status).toBe(0);
  });
});
