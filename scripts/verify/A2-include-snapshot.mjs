#!/usr/bin/env node
/**
 * scripts/verify/A2-include-snapshot.mjs
 *
 * Issue #845 reproducer for the opt-in post-action snapshot chain
 * (`returnAfterState`, the OpenChrome equivalent of includeSnapshot).
 *
 * Default mode is hermetic: verify source/test anchors and print the live MCP
 * checklist. Use --unit to run the focused return-after-state/hint coverage.
 *
 * Usage:
 *   node scripts/verify/A2-include-snapshot.mjs
 *   node scripts/verify/A2-include-snapshot.mjs --unit
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit, stderr } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const args = new Set(process.argv.slice(2));

const inputTools = [
  'src/tools/interact.ts',
  'src/tools/form-input.ts',
  'src/tools/fill-form.ts',
  'src/tools/act.ts',
  'src/tools/computer.ts',
];

function log(line = '') {
  stderr.write(`${line}\n`);
}

function fail(message) {
  log(`[A2-include-snapshot] FAIL: ${message}`);
  exit(1);
}

function ok(message) {
  log(`[A2-include-snapshot] OK: ${message}`);
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

function runUnitSuites() {
  log('# running focused #845 Jest suites');
  const result = spawnSync(
    'npm',
    [
      'test',
      '--',
      'tests/e2e/return-after-state.test.ts',
      'tests/hints/hint-engine.test.ts',
      '--runInBand',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) fail(`focused Jest suites exited ${result.status}`);
  ok('focused #845 Jest suites passed');
}

function printChecklist() {
  log('');
  log('# OpenChrome MCP live checklist for #845');
  log('1. Build and start openchrome, then navigate to https://news.ycombinator.com/.');
  log('2. interact action=click target={text:"new"} returnAfterState=dom.');
  log('   Expect result.success=true plus state.mode=dom and a post-click snapshot for /newest.');
  log('3. Repeat baseline without returnAfterState, then call read_page mode=dom.');
  log('   Expect chained response bytes < standalone interact + standalone read_page bytes.');
  log('4. fill_form on https://httpbin.org/forms/post with returnAfterState=ax.');
  log('   Expect AX snapshot containing the filled custname/custtel/custemail values.');
  log('5. Trigger an action failure with returnAfterState=dom.');
  log('   Expect no misleading success snapshot.');
  log('6. oc_journal filter="tool=interact AND returnAfterState=dom".');
  log('   Expect args summary records the option.');
  log('7. Compare hint behavior: omitted returnAfterState may suggest read_page; opt-in returnAfterState suppresses that stale-observation hint.');
  log('');
}

log('# A2-include-snapshot verifier — issue #845');

requireContains('src/tools/_shared/return-after-state.ts', "export type ReturnAfterState = 'none' | 'ax' | 'dom'", 'shared enum exists');
requireContains('src/tools/_shared/return-after-state.ts', 'readPageHandlerForReuse', 'snapshot uses read_page code path');
requireContains('src/tools/_shared/return-after-state.ts', 'appendReturnAfterState', 'shared response appender exists');
requireContains('src/tools/read-page.ts', 'readPageHandlerForReuse', 'read_page exposes reusable handler');

for (const toolPath of inputTools) {
  requireContains(toolPath, 'returnAfterState', 'input tool accepts returnAfterState');
}

requireContains('src/hints/rules/sequence-detection.ts', 'returnAfterState', 'sequence hints observe returnAfterState');
requireContains('src/hints/rules/composite-suggestions.ts', 'returnAfterState', 'composite hints observe returnAfterState');
requireContains('tests/e2e/return-after-state.test.ts', 'token-cost guard (combined < a + b)', 'token-cost guard exists');
requireContains('tests/e2e/return-after-state.test.ts', 'returnAfterState helper (issue #845)', 'focused helper coverage exists');
requireContains('tests/fixtures/return-after-state/index.html', 'return-after-state fixture', 'deterministic fixture exists');

printChecklist();

if (args.has('--unit')) {
  runUnitSuites();
} else {
  log('Run with --unit for focused Jest verification.');
  ok('static #845 contract anchors verified');
}
