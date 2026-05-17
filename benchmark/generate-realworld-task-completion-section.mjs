#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { findClaimEligibilityFailures } from './claim-eligibility.mjs';
import { requireHeadlineReport } from './headline-gate.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const INPUT_PATH = path.join(REPO_ROOT, 'benchmark', 'results', 'realworld-task-completion.json');
const OUTPUT_PATH = path.join(REPO_ROOT, 'benchmark', 'results', 'REALWORLD-TASK-COMPLETION-REPORT.md');

function pct(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function n(value) {
  return value === null || value === undefined ? 'n/a' : Number(value).toFixed(1).replace(/\.0$/, '');
}

function main(argv = process.argv.slice(2)) {
  const requireHeadline = argv.includes('--require-headline');
  if (!existsSync(INPUT_PATH)) {
    process.stderr.write(`Missing ${path.relative(REPO_ROOT, INPUT_PATH)}. Run \`npm run bench:realworld\` first.\n`);
    process.exit(1);
  }

  const envelope = JSON.parse(readFileSync(INPUT_PATH, 'utf8'));
  const result = envelope.results?.[0];
  if (!result) {
    process.stderr.write('realworld-task-completion.json has no result payload.\n');
    process.exit(1);
  }

  if (requireHeadline) {
    requireHeadlineReport(envelope, 'realworld-task-completion');
  }
  const eligibilityFailures = findClaimEligibilityFailures(envelope);

  const lines = [];
  lines.push('# Complex Real-World Task Completion (#1305)');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source: \`benchmark/results/realworld-task-completion.json\` (axis: \`${envelope.axis}\`).`);
  lines.push('');
  lines.push('## Claim scope');
  lines.push('');
  lines.push(`- Measurement mode: \`${result.measurementMode}\``);
  lines.push(`- Claim scope: **${result.claimScope}**`);
  lines.push('- This report is the scaffold/local-fixture baseline for the real-world task-completion axis. It is **not** a live competitive win claim.');
  if (result.claimEligibility) {
    lines.push(`- Claim eligibility tier: **${result.claimEligibility.tier}**; eligible: **${result.claimEligibility.eligible ? 'yes' : 'no'}**.`);
    for (const reason of result.claimEligibility.reasons ?? []) lines.push(`  - Blocker: ${reason}`);
  } else {
    lines.push('- Claim eligibility: **missing** (headline generation must fail when `--require-headline` is used).');
  }
  if (eligibilityFailures.length > 0) lines.push('- Headline gate: **blocked**. Use `node benchmark/generate-realworld-task-completion-section.mjs --require-headline` in release workflows to enforce this.');
  lines.push('- #1261 remains the DX/supporting axis; this section is the primary task-completion axis.');
  lines.push('');

  lines.push('## Metrics by library');
  lines.push('');
  lines.push('| Library | Mode | Runs | Success | First-attempt success | Recovery success | Mean tool calls | Mean wall time ms | p95 wall time ms |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const metric of result.metrics ?? []) {
    lines.push(`| \`${metric.library}\` | \`${metric.mode}\` | ${metric.totalRuns} | ${pct(metric.successRate)} | ${pct(metric.firstAttemptSuccessRate)} | ${pct(metric.recoverySuccessRate)} | ${n(metric.meanToolCalls)} | ${n(metric.meanWallTimeMs)} | ${n(metric.p95WallTimeMs)} |`);
  }
  lines.push('');

  lines.push('## Task corpus');
  lines.push('');
  lines.push('| Task | Tier | Max steps | Recovery? | Complexity tags |');
  lines.push('| --- | --- | ---: | --- | --- |');
  for (const task of result.tasks ?? []) {
    lines.push(`| \`${task.id}\` ${task.title} | ${task.tier} | ${task.maxSteps} | ${task.requiresRecovery ? 'yes' : 'no'} | ${task.complexityTags.join(', ')} |`);
  }
  lines.push('');

  lines.push('## Next measurement work');
  lines.push('');
  lines.push('- Add live OpenChrome / playwright-mcp / Puppeteer MCP / browsermcp adapter rows only after real execution.');
  lines.push('- Pin competitor and LLM versions before publishing live comparisons.');
  lines.push('- Keep local deterministic fixture rows separate from live-web rows.');
  lines.push('');

  writeFileSync(OUTPUT_PATH, lines.join('\n'));
  process.stderr.write(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}\n`);
}

main();
