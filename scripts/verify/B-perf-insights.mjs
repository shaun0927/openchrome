#!/usr/bin/env node
/**
 * scripts/verify/B-perf-insights.mjs
 *
 * Issue #846 reproducer for the two-step performance insight API:
 *   1. oc_performance_insights captures a trace and returns named summaries.
 *   2. oc_performance_analyze drills into one named insight by trace_id.
 *
 * Default mode is hermetic and dependency-free: it checks the source/test
 * anchors that make the live flow reviewable, then prints the MCP checklist.
 * Use --unit to run the focused Jest suites that exercise the engine/tool
 * contracts without launching a browser.
 *
 * Usage:
 *   node scripts/verify/B-perf-insights.mjs
 *   node scripts/verify/B-perf-insights.mjs --unit
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit, stderr } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const args = new Set(process.argv.slice(2));

const requiredInsights = [
  'LCPBreakdown',
  'DocumentLatency',
  'RenderBlocking',
  'CLSCulprits',
  'LongTasks',
  'ThirdParties',
];

function log(line = '') {
  stderr.write(`${line}\n`);
}

function fail(message) {
  log(`[B-perf-insights] FAIL: ${message}`);
  exit(1);
}

function ok(message) {
  log(`[B-perf-insights] OK: ${message}`);
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
  if (!regex.test(text)) fail(`${relPath} does not match ${regex} (${reason})`);
  ok(`${relPath}: ${reason}`);
}

function runUnitSuites() {
  log('# running focused #846 Jest suites');
  const result = spawnSync(
    'npm',
    [
      'test',
      '--',
      'tests/core/performance/insights/evaluators.test.ts',
      'tests/core/performance/insights/trace-store.test.ts',
      'tests/tools/oc-performance-analyze.test.ts',
      'tests/tools/oc-performance-insights-registration.test.ts',
      'tests/tools/oc-performance-insights-reset.test.ts',
      '--runInBand',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) fail(`focused Jest suites exited ${result.status}`);
  ok('focused #846 Jest suites passed');
}

function printChecklist() {
  log('');
  log('# OpenChrome MCP live checklist for #846');
  log('1. Build and start openchrome from this branch.');
  log('2. tabs_create/navigate to the page under test and record tabId.');
  log('3. oc_performance_insights tabId=<tabId> reload=true network=fast-3g cpuThrottling=4 autoStop=load.');
  log('   Expect trace_id, trace_path, summary_md, and all six insight names.');
  log('4. oc_performance_analyze trace_id=<trace_id> insight=LCPBreakdown.');
  log('   Expect Markdown details plus at least one metric/request/event evidence ref when data exists.');
  log('5. oc_performance_analyze insight=NotARealInsight.');
  log('   Expect { error: unknown_insight, supported: [...] } without a server crash.');
  log('6. oc_journal filter=tool=oc_performance_insights; verify args and trace_id are logged without raw trace payload.');
  log('7. Measure journal content sizes: insights response <= 8 KB; analyze response <= 16 KB on fixture pages.');
  log('8. Restart with OPENCHROME_PERF_INSIGHTS=0; tools/list must omit both performance insight tools.');
  log('');
}

log('# B-perf-insights verifier — issue #846');

for (const name of requiredInsights) {
  requireContains('src/core/performance/insights/types.ts', `'${name}'`, `closed-set insight includes ${name}`);
}
requireContains('src/core/performance/insights/index.ts', 'buildSummaryMarkdown', 'summary Markdown builder exists');
requireContains('src/core/performance/insights/evaluators.ts', 'export const EVALUATORS', 'evaluator dispatch table exists');
requireContains('src/core/performance/insights/trace-store.ts', "path.join(os.homedir(), '.openchrome', 'perf-traces')", 'trace store uses os.homedir perf-traces path');
requireContains('src/core/performance/insights/trace-store.ts', 'evictSession(sessionId: string)', 'session-scoped trace eviction exists');
requireContains('src/tools/oc-performance-insights.ts', 'name: \'oc_performance_insights\'', 'step-1 MCP tool is defined');
requireContains('src/tools/oc-performance-insights.ts', 'trace_id: handle.trace_id', 'step-1 returns trace_id handle');
requireContains('src/tools/oc-performance-insights.ts', 'summary_md: summaryMd', 'step-1 returns Markdown summary');
requireContains('src/tools/oc-performance-analyze.ts', 'name: \'oc_performance_analyze\'', 'step-2 MCP tool is defined');
requireContains('src/tools/oc-performance-analyze.ts', "error: 'unknown_insight'", 'unknown insight returns structured error');
requireContains('src/tools/oc-performance-analyze.ts', 'handle.session_id !== sessionId', 'trace handles are session-scoped');
requireRegex('src/tools/index.ts', /OPENCHROME_PERF_INSIGHTS\s*!==\s*'0'/, 'registration off-switch is present');
requireContains('tests/core/performance/fixtures/sample-trace.ts', 'traceEvents', 'fixture trace exists');
requireContains('tests/core/performance/insights/evaluators.test.ts', 'LCPBreakdown', 'engine fixture tests cover LCPBreakdown');
requireContains('tests/tools/oc-performance-analyze.test.ts', 'unknown_insight', 'tool tests cover unknown insight recovery');
requireContains('tests/tools/oc-performance-insights-registration.test.ts', 'OPENCHROME_PERF_INSIGHTS=0', 'off-switch parity test exists');

printChecklist();

if (args.has('--unit')) {
  runUnitSuites();
} else {
  log('Run with --unit for focused Jest verification.');
  ok('static #846 contract anchors verified');
}
