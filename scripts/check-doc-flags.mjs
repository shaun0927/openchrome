#!/usr/bin/env node
/**
 * check-doc-flags.mjs
 *
 * Doc-drift guard for docs/getting-started/http-daemon.md.
 *
 * Scans the doc for every --flag and OPENCHROME_* env-var mention, then
 * asserts each one appears somewhere in src/index.ts. Exits with code 1
 * and a human-readable error if any documented symbol is missing from
 * source, so doc drift is caught in CI before it confuses operators.
 *
 * Usage:
 *   node scripts/check-doc-flags.mjs
 *
 * Called by tests/docs/http-daemon-flags.test.ts as part of `npm test`.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const DOC_PATH = join(ROOT, 'docs', 'getting-started', 'http-daemon.md');
const SRC_PATH = join(ROOT, 'src', 'index.ts');

/**
 * Flags that appear in curl/shell/PowerShell examples in the doc but are NOT
 * OpenChrome flags. We skip these so the check stays focused on the server's
 * own CLI surface.
 */
const EXTERNAL_FLAGS = new Set([
  '--data',
  '--data-raw',
  '--header',
  '--request',
  '--silent',
  '--verbose',
  '--url',
  '--output',
  '--location',
  '--fail',
  '--user',
  '--max-time',
  '--connect-timeout',
  '--no-verify',
  '--insecure',
]);

/**
 * Extract every --flag and OPENCHROME_* token from the doc.
 * Returns an object with two arrays: flags and envVars.
 */
function extractDocSymbols(docText) {
  // Match --word (flag names, including --http-host, --allow-unauthenticated-http, etc.)
  const flagMatches = [...docText.matchAll(/--([a-z][a-z0-9-]+)/g)]
    .map((m) => `--${m[1]}`)
    .filter((f) => !EXTERNAL_FLAGS.has(f));

  // Match OPENCHROME_WORD (env var names)
  const envMatches = [...docText.matchAll(/(OPENCHROME_[A-Z0-9_]+)/g)].map(
    (m) => m[1],
  );

  // Deduplicate
  const flags = [...new Set(flagMatches)];
  const envVars = [...new Set(envMatches)];

  return { flags, envVars };
}

/**
 * Run the check. Returns { ok: boolean, missing: string[] }.
 * Exported so the Jest test can import it without shelling out.
 */
export function checkDocFlags() {
  const docText = readFileSync(DOC_PATH, 'utf8');
  const srcText = readFileSync(SRC_PATH, 'utf8');

  const { flags, envVars } = extractDocSymbols(docText);

  const missing = [];

  for (const flag of flags) {
    // src/index.ts uses .option('--flag-name ...) syntax
    if (!srcText.includes(flag)) {
      missing.push(flag);
    }
  }

  for (const envVar of envVars) {
    if (!srcText.includes(envVar)) {
      missing.push(envVar);
    }
  }

  return { ok: missing.length === 0, missing, flags, envVars };
}

// When run directly as a script, print results and exit
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { ok, missing, flags, envVars } = checkDocFlags();

  console.error(`[check-doc-flags] Scanned doc: ${DOC_PATH}`);
  console.error(`[check-doc-flags] Source:      ${SRC_PATH}`);
  console.error(
    `[check-doc-flags] Found ${flags.length} flag(s), ${envVars.length} env var(s) in doc.`,
  );

  if (ok) {
    console.error('[check-doc-flags] All documented symbols found in source. OK.');
    process.exit(0);
  } else {
    console.error(
      `[check-doc-flags] FAIL: ${missing.length} symbol(s) documented but not found in src/index.ts:`,
    );
    for (const sym of missing) {
      console.error(`  - ${sym}`);
    }
    console.error(
      '[check-doc-flags] Either remove the symbol from the doc or add it to src/index.ts.',
    );
    process.exit(1);
  }
}
