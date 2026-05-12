#!/usr/bin/env node
/**
 * Build-output lint: assert that every occurrence of the dev-only hook env
 * var names in dist/ is guarded by the canonical dev-hooks gate expression.
 *
 * The hooks OPENCHROME_FAKE_SLOW_START and OPENCHROME_FAKE_SLOW_TOOLS are
 * gated by:
 *   process.env.NODE_ENV !== 'production' && process.env.OPENCHROME_DEV_HOOKS === '1'
 *
 * TypeScript does not constant-fold process.env.NODE_ENV at compile time, so
 * the strings appear in dist/ but are always dead at runtime when NODE_ENV is
 * set to "production" (the required value in container / production builds).
 *
 * This script verifies two things:
 *   1. Every .js file in dist/ that mentions a FAKE_SLOW_ name also contains
 *      the gate guard string — i.e. the code was not accidentally written
 *      without the guard.
 *   2. The strings do NOT appear in any file outside of src/index.js — they
 *      must not leak into tool registrations, the MCP protocol layer, etc.
 *
 * Usage (from repo root):
 *   node scripts/verify/A6-no-dev-hooks-in-dist.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const distDir = join(repoRoot, 'dist');

const HOOK_NAMES = [
  'OPENCHROME_FAKE_SLOW_START',
  'OPENCHROME_FAKE_SLOW_TOOLS',
];

/** The gate expression that must co-exist in any file containing a hook name. */
const GATE_EXPRESSION = 'OPENCHROME_DEV_HOOKS';

/** Only dist/index.js (compiled from src/index.ts) is allowed to contain hook names. */
const ALLOWED_FILE_SUFFIX = join('dist', 'index.js');

async function collectJs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJs(full)));
    } else if (entry.isFile() && extname(entry.name) === '.js') {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  let jsFiles;
  try {
    jsFiles = await collectJs(distDir);
  } catch (err) {
    console.error(`[A6-lint] ERROR: cannot read dist/ — run 'npm run build' first.`);
    console.error(err.message);
    process.exit(1);
  }

  if (jsFiles.length === 0) {
    console.error(`[A6-lint] ERROR: dist/ contains no .js files — run 'npm run build' first.`);
    process.exit(1);
  }

  const violations = [];

  for (const file of jsFiles) {
    const src = await readFile(file, 'utf8');
    const rel = relative(repoRoot, file);

    for (const hookName of HOOK_NAMES) {
      if (!src.includes(hookName)) continue;

      // Hook name found — check it's in the allowed file
      if (!file.endsWith(ALLOWED_FILE_SUFFIX)) {
        violations.push({
          file: rel,
          hookName,
          reason: `hook name found outside dist/index.js`,
        });
        continue;
      }

      // Allowed file — verify the gate guard is present in the same file
      if (!src.includes(GATE_EXPRESSION)) {
        violations.push({
          file: rel,
          hookName,
          reason: `hook name present but gate guard "${GATE_EXPRESSION}" not found`,
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error('[A6-lint] FAIL: dev-hook guard violations found in dist/');
    for (const { file, hookName, reason } of violations) {
      console.error(`  ${file}: "${hookName}" — ${reason}`);
    }
    console.error('');
    console.error('Dev-only hooks must only appear in dist/index.js and must be');
    console.error(`guarded by the "${GATE_EXPRESSION}" gate expression.`);
    process.exit(1);
  }

  console.log(`[A6-lint] OK: dev-hook guard check passed (${jsFiles.length} dist/ JS files scanned).`);
}

main();
