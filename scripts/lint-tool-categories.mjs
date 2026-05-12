#!/usr/bin/env node
/**
 * lint-tool-categories.mjs (#847)
 *
 * CI guard: every tool name registered via REGISTRATION_ENTRIES in
 * src/tools/index.ts must be present in TOOL_TO_CATEGORY in
 * src/tools/_shared/category.ts. A missing entry would either fail loud at
 * runtime (registerAllTools throws) or — worse — silently default into the
 * full surface even when the operator passed --slim. This script catches
 * both classes of regression at PR time.
 *
 * Strategy:
 *   1. Read src/tools/index.ts and extract every entry of the form
 *      `tools: ['name', ...]` from REGISTRATION_ENTRIES.
 *   2. Read src/tools/_shared/category.ts and extract every key of
 *      TOOL_TO_CATEGORY.
 *   3. Diff. Exit non-zero on any mismatch (missing assignment OR stale
 *      entry no longer used by any registrar).
 *
 * Why a regex parser instead of importing the modules:
 *   - Keeps the script dependency-free and runnable in pre-build CI stages
 *     (no need to compile TypeScript first).
 *   - The `tools:` and `TOOL_TO_CATEGORY` shapes are deliberately simple
 *     literal arrays/objects with no interpolation — see the comments in
 *     src/tools/_shared/category.ts and src/tools/index.ts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const indexPath = join(repoRoot, 'src', 'tools', 'index.ts');
const categoryPath = join(repoRoot, 'src', 'tools', '_shared', 'category.ts');

function readSource(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(
      `[lint-tool-categories] Could not read ${filePath}: ${err.message}`,
    );
    process.exit(2);
  }
}

/**
 * Extract every `tools: ['a', 'b', ...]` array from REGISTRATION_ENTRIES.
 * Multi-line arrays are supported — the regex spans newlines.
 */
function extractRegisteredNames(source) {
  const names = new Set();
  // Match `tools: [ ... ]` — the array body may span multiple lines.
  const re = /tools:\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const body = m[1];
    const stringRe = /['"]([A-Za-z0-9_]+)['"]/g;
    let s;
    while ((s = stringRe.exec(body)) !== null) {
      names.add(s[1]);
    }
  }
  return names;
}

/**
 * Extract every key from `TOOL_TO_CATEGORY = { ... }` — both bare-identifier
 * keys (`navigate: 'navigation',`) and quoted-string keys.
 */
function extractCategorizedNames(source) {
  const names = new Set();
  const objMatch = source.match(
    /TOOL_TO_CATEGORY[^=]*=\s*{([\s\S]*?)\n};?/,
  );
  if (!objMatch) {
    console.error(
      '[lint-tool-categories] Could not locate TOOL_TO_CATEGORY object literal in category.ts',
    );
    process.exit(2);
  }
  const body = objMatch[1];
  // Match a property line: leading whitespace, an identifier or quoted name,
  // a colon, then a quoted category. Comments are skipped because they don't
  // contain `:` followed by a quoted token at the start of a line.
  const propRe = /(?:^|\n)\s*(?:['"]([A-Za-z0-9_]+)['"]|([A-Za-z_][A-Za-z0-9_]*))\s*:\s*['"][a-z]+['"]/g;
  let m;
  while ((m = propRe.exec(body)) !== null) {
    names.add(m[1] ?? m[2]);
  }
  return names;
}

const indexSource = readSource(indexPath);
const categorySource = readSource(categoryPath);

const registered = extractRegisteredNames(indexSource);
const categorized = extractCategorizedNames(categorySource);

const missing = [...registered].filter((n) => !categorized.has(n)).sort();
const stale = [...categorized].filter((n) => !registered.has(n)).sort();

if (missing.length === 0 && stale.length === 0) {
  console.error(
    `[lint-tool-categories] OK — ${registered.size} registered tools all have a category assignment.`,
  );
  process.exit(0);
}

if (missing.length > 0) {
  console.error(
    `[lint-tool-categories] FAIL — ${missing.length} tool(s) registered in src/tools/index.ts have no entry in TOOL_TO_CATEGORY:`,
  );
  for (const name of missing) {
    console.error(`  - ${name}`);
  }
  console.error(
    '  Fix: add each name to src/tools/_shared/category.ts under the appropriate category.',
  );
}

if (stale.length > 0) {
  console.error(
    `[lint-tool-categories] FAIL — ${stale.length} stale entry/entries in TOOL_TO_CATEGORY no longer correspond to any registered tool:`,
  );
  for (const name of stale) {
    console.error(`  - ${name}`);
  }
  console.error(
    '  Fix: remove from src/tools/_shared/category.ts (or re-register the tool in src/tools/index.ts).',
  );
}

process.exit(1);
