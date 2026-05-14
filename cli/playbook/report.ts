/**
 * Playbook reporter — formats a RunResult as JSON, Markdown, or plain stdout.
 *
 * --json  : JSON shape { name, steps, summary }
 * --out   : Markdown table written to file
 * default : One-liner per step + final summary on stdout
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RunResult, StepResult } from './run';

const STATUS_ICON: Record<string, string> = {
  ok: 'PASS',
  failed: 'FAIL',
  skipped: 'SKIP',
};

function formatPlain(result: RunResult): string {
  const lines: string[] = [];
  const name = result.name ?? '(unnamed playbook)';
  lines.push(`Playbook: ${name}`);
  lines.push('');

  for (const step of result.steps) {
    const icon = STATUS_ICON[step.status] ?? step.status.toUpperCase();
    const dur = step.status === 'skipped' ? '-' : `${step.durationMs}ms`;
    lines.push(`  [${icon}] step ${step.index}: ${step.verb} (${dur})`);
    if (step.error) {
      lines.push(`         ${step.error}`);
    }
  }

  lines.push('');
  const { ok, total, passed, failed, skipped } = result.summary;
  lines.push(`Summary: ${ok ? 'PASS' : 'FAIL'} — ${passed}/${total} passed, ${failed} failed, ${skipped} skipped`);
  return lines.join('\n');
}

function formatMarkdown(result: RunResult): string {
  const name = result.name ?? '(unnamed playbook)';
  const lines: string[] = [];
  lines.push(`# Playbook: ${name}`);
  lines.push('');
  lines.push('| # | Verb | Tool | Status | Duration |');
  lines.push('|---|------|------|--------|----------|');

  for (const step of result.steps) {
    const dur = step.status === 'skipped' ? '-' : `${step.durationMs}ms`;
    lines.push(`| ${step.index} | \`${step.verb}\` | \`${step.tool || '-'}\` | ${step.status.toUpperCase()} | ${dur} |`);
  }

  lines.push('');
  const { ok, total, passed, failed, skipped } = result.summary;
  lines.push(`**Result:** ${ok ? 'PASS' : 'FAIL'} — ${passed}/${total} passed, ${failed} failed, ${skipped} skipped`);

  return lines.join('\n');
}

export interface ReportOptions {
  json: boolean;
  outPath?: string;
}

export function writeReport(result: RunResult, options: ReportOptions): void {
  if (options.json) {
    // JSON output to stdout
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (options.outPath) {
    const md = formatMarkdown(result);
    const dir = path.dirname(options.outPath);
    if (dir && dir !== '.') {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(options.outPath, md + '\n', 'utf8');
    // Also print plain summary to stdout
    const { ok, total, passed, failed, skipped } = result.summary;
    console.log(`Report written to ${options.outPath}`);
    console.log(`Result: ${ok ? 'PASS' : 'FAIL'} — ${passed}/${total} passed, ${failed} failed, ${skipped} skipped`);
    return;
  }

  // Plain stdout
  console.log(formatPlain(result));
}

// Re-export for use in tests
export { formatPlain, formatMarkdown };

export function buildStepResult(step: StepResult): StepResult {
  return step;
}
