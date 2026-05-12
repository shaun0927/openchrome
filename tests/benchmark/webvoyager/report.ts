/**
 * Markdown renderer for the WebVoyager benchmark report.
 *
 * The Markdown is committed alongside the JSON under reports/<git-sha>.md
 * so PR reviewers can see the score without running the harness locally.
 */

import type { BenchReport, TaskRunReport } from './types';

export function renderMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(`# WebVoyager contract-eval report`);
  lines.push('');
  lines.push(`- git_sha: \`${report.git_sha}\``);
  lines.push(`- adapter: \`${report.adapter}\``);
  lines.push(`- timestamp: \`${report.timestamp}\``);
  lines.push(
    `- contract_eval_score: **${report.contract_eval_score}** ` +
      `(pass=${report.pass_count}, fail=${report.fail_count}, pending=${report.pending_count}, total=${report.total_tasks})`,
  );
  // Explicit pending count restated in the header so PR reviewers reading
  // only the rendered Markdown see right away that some tasks haven't been
  // verified yet (transcripts not recorded). The gate intentionally lets
  // pending tasks pass through; this line keeps the report honest.
  lines.push(
    `- pending tasks: **${report.pending_count}** of ${report.total_tasks} ` +
      `(no frozen transcript yet — skipped by mock runner)`,
  );
  lines.push('');
  lines.push('## Per-task results');
  lines.push('');
  lines.push('| Task | Result | Duration (ms) | Tool calls | Response bytes | Failed postcondition |');
  lines.push('| --- | --- | ---: | ---: | ---: | --- |');
  for (const t of report.tasks) {
    lines.push(rowFor(t));
  }
  lines.push('');
  lines.push('## Comparison footer');
  lines.push('');
  lines.push(
    '- notte open-operator-evals (WebVoyager30, self-reported): 86.2% self-eval, ' +
      '79.0% LLM-eval, 47s median wall-time per task.',
  );
  lines.push(
    '- OpenChrome scores are contract-eval (URL / DOM / network / screenshot ' +
      'postconditions decided by `src/contracts/evaluate.ts`), which is stricter ' +
      'than LLM-judge eval and intentionally not directly comparable to notte\'s ' +
      'numbers.',
  );
  lines.push('');
  return lines.join('\n');
}

function rowFor(t: TaskRunReport): string {
  const failed = t.failed_postcondition ?? (t.error ? `error: ${t.error}` : '');
  return `| ${escape(t.name)} | ${t.result} | ${t.duration_ms} | ${t.tool_calls} | ${t.response_bytes} | ${escape(failed)} |`;
}

function escape(s: string): string {
  return s.replace(/\|/g, '\\|');
}
