#!/usr/bin/env node
/**
 * scripts/verify/D-isolated-context.mjs
 *
 * Issue #848 reproducer for `tabs_create({ isolatedContext })` named
 * BrowserContexts. The default mode is hermetic: it verifies that the repo
 * contains the implementation/test anchors required for the issue contract and
 * prints the live OpenChrome MCP checklist. Use --live to delegate to the gated
 * real-Chrome Jest coverage.
 *
 * Usage:
 *   node scripts/verify/D-isolated-context.mjs
 *   OPENCHROME_REAL_CHROME=1 OPENCHROME_TEST_CHROME=/path/to/chrome node scripts/verify/D-isolated-context.mjs --live
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit, stderr } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const args = new Set(process.argv.slice(2));

function log(line = '') {
  stderr.write(`${line}\n`);
}

function fail(message) {
  log(`[D-isolated-context] FAIL: ${message}`);
  exit(1);
}

function ok(message) {
  log(`[D-isolated-context] OK: ${message}`);
}

function read(relPath) {
  const path = join(repoRoot, relPath);
  if (!existsSync(path)) fail(`missing required file: ${relPath}`);
  return readFileSync(path, 'utf8');
}

function requireContains(relPath, needle, reason) {
  const text = read(relPath);
  if (!text.includes(needle)) {
    fail(`${relPath} missing ${JSON.stringify(needle)} (${reason})`);
  }
  ok(`${relPath}: ${reason}`);
}

function requireRegex(relPath, regex, reason) {
  const text = read(relPath);
  if (!regex.test(text)) {
    fail(`${relPath} does not match ${regex} (${reason})`);
  }
  ok(`${relPath}: ${reason}`);
}

function runLive() {
  log('# live verification: gated real-Chrome Jest coverage for #848');
  const result = spawnSync(
    'npm',
    [
      'test',
      '--',
      'tests/chrome/contexts.test.ts',
      'tests/integration/contexts/cookie-isolation.test.ts',
      'tests/integration/contexts/popup-accounting.test.ts',
      '--runInBand',
    ],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, OPENCHROME_REAL_CHROME: process.env.OPENCHROME_REAL_CHROME || '1' },
    },
  );
  if (result.status !== 0) fail(`live Jest verification exited ${result.status}`);
  ok('live Jest verification passed');
}

function printChecklist() {
  log('');
  log('# OpenChrome MCP live checklist for #848');
  log('1. Start openchrome from this branch.');
  log('2. tabs_create url=https://httpbin.org/cookies/set?who=alice isolatedContext=acct-A; expect context.name=acct-A and isolated=true.');
  log('3. tabs_create url=https://httpbin.org/cookies/set?who=bob isolatedContext=acct-B; expect context.name=acct-B and isolated=true.');
  log('4. Navigate/read acct-A cookies; expect alice and not bob.');
  log('5. Navigate/read acct-B cookies; expect bob and not alice.');
  log('6. cookies list per tab; expect no cross-context leakage.');
  log('7. oc_connection_health; expect one Chrome process serving both named contexts.');
  log('8. tabs_close the only acct-A tab, then recreate acct-A; expect no leaked alice cookie.');
  log('9. tabs_create without isolatedContext; expect context.name=default and isolated=false.');
  log('10. oc_journal filter=context=acct-A; expect only acct-A scoped calls.');
  log('');
  log('For hermetic CI, use the Jest coverage below instead of httpbin.org.');
}

log('# D-isolated-context verifier — issue #848');

requireContains('src/chrome/contexts.ts', 'export interface NamedContextRegistry', 'registry interface exists');
requireContains('src/chrome/contexts.ts', 'browser.createBrowserContext()', 'uses current puppeteer BrowserContext spelling');
requireContains('src/chrome/contexts.ts', 'Names must match `[A-Za-z0-9_-]{1,64}`', 'documents name constraints');
requireContains('src/tools/tabs-create.ts', 'isolatedContext', 'tabs_create accepts isolatedContext');
requireContains('src/tools/tabs-create.ts', 'context: { name: contextName, isolated }', 'tabs_create returns resolved context');
requireContains('src/tools/tabs-context.ts', 'context: sessionManager.getTargetContextName(targetId)', 'tabs_context tags each tab with context name');
requireRegex('src/session-manager.ts', /targetToContext\.set\(targetId, \{ browser: ownerBrowser, name: isolatedContext \}\)/, 'session manager tracks target-to-context ownership');
requireRegex('src/session-manager.ts', /flush per named context \(default \+ each isolatedContext\)/, 'storage flush partitioning path is present');
requireContains('tests/chrome/contexts.test.ts', 'NamedContextRegistry', 'unit tests cover registry behavior');
requireContains('tests/integration/contexts/cookie-isolation.test.ts', 'cookies set in context A are not visible in context B', 'integration test covers cookie isolation');
requireContains('tests/integration/contexts/popup-accounting.test.ts', 'Popup tab-count accounting', 'integration test covers lifecycle accounting');

printChecklist();

if (args.has('--live')) {
  runLive();
} else {
  log('Run with --live and OPENCHROME_TEST_CHROME=/path/to/chrome for real Chrome verification.');
  ok('static #848 contract anchors verified');
}
