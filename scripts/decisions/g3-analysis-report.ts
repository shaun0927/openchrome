import * as fs from 'fs';
import * as path from 'path';

const outDir = path.join('artifacts', 'decision', 'G3');
const reportPath = path.join(outDir, 'ANALYSIS_REPORT.md');
const reportJsonPath = path.join(outDir, 'analysis-report.json');
const ledgerPath = path.join('..', 'openchrome-decider-ledger.json');

interface Gate {
  readonly state: string;
  readonly evidence: readonly string[];
  readonly closed_at: string | null;
  readonly note?: string;
}

interface Ledger {
  readonly recomputed_at: string;
  readonly gates: Record<string, Gate>;
  readonly next_action?: string;
  readonly pending?: readonly { readonly item: string; readonly reason: string }[];
}

interface DecisionMemo {
  readonly verdict: string;
  readonly summary: string;
  readonly gateway: {
    readonly jev_model_available: boolean;
    readonly model_id: string | null;
    readonly endpoint: string | null;
    readonly key_variable: string | null;
  };
  readonly insertions: readonly {
    readonly insertion: string;
    readonly recommendation: string;
    readonly b_cases: number;
    readonly current_regex_accuracy: number | null;
    readonly jev_status: string;
    readonly host_status: string;
  }[];
}

interface ImplementationMap {
  readonly maps: readonly {
    readonly insertion: string;
    readonly implementation_status: string;
    readonly proposed_jev_role: string;
    readonly primary_anchors: readonly {
      readonly path: string;
      readonly symbol: string;
      readonly evidence: string;
    }[];
  }[];
}

interface Preflight {
  readonly ok_to_close: boolean;
  readonly checks: readonly {
    readonly id: string;
    readonly ok: boolean;
    readonly detail: string;
  }[];
}

interface LedgerAudit {
  readonly ok: boolean;
  readonly evidence_count: number;
  readonly missing_evidence: readonly string[];
  readonly bad_status_values: readonly unknown[];
}

interface ClaudeReconstruction {
  readonly session: {
    readonly id: string;
    readonly path: string;
    readonly branch: string | null;
    readonly last_user_message: string | null;
    readonly last_assistant_response: string | null;
  };
  readonly task_notifications: readonly {
    readonly status: string;
  }[];
  readonly subagents: readonly unknown[];
}

interface AnalysisReport {
  readonly generated_at: string;
  readonly ledger_recomputed_at: string;
  readonly verdict: 'g3_open';
  readonly gates: Record<string, { readonly state: string; readonly closed_at: string | null; readonly evidence_count: number }>;
  readonly current_candidates: readonly string[];
  readonly deferred_or_excluded: readonly string[];
  readonly ledger_audit_ok: boolean;
  readonly claude_reconstruction: {
    readonly task_notifications: number;
    readonly subagents: number;
    readonly failed_tasks: number;
  };
  readonly closure_blockers: readonly string[];
  readonly next_action: string | null;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function gateSummary(ledger: Ledger): AnalysisReport['gates'] {
  const entries = Object.entries(ledger.gates).map(([name, gate]) => [name, {
    state: gate.state,
    closed_at: gate.closed_at,
    evidence_count: gate.evidence.length,
  }]);
  return Object.fromEntries(entries);
}

function reportData(ledger: Ledger, memo: DecisionMemo, preflight: Preflight, audit: LedgerAudit, claude: ClaudeReconstruction): AnalysisReport {
  return {
    generated_at: new Date().toISOString(),
    ledger_recomputed_at: ledger.recomputed_at,
    verdict: 'g3_open',
    gates: gateSummary(ledger),
    current_candidates: memo.insertions.filter((item) => item.recommendation === 'candidate').map((item) => item.insertion),
    deferred_or_excluded: memo.insertions.filter((item) => item.recommendation !== 'candidate').map((item) => item.insertion),
    ledger_audit_ok: audit.ok,
    claude_reconstruction: {
      task_notifications: claude.task_notifications.length,
      subagents: claude.subagents.length,
      failed_tasks: claude.task_notifications.filter((task) => task.status === 'failed').length,
    },
    closure_blockers: preflight.checks.filter((check) => !check.ok).map((check) => `${check.id}: ${check.detail}`),
    next_action: ledger.next_action ?? null,
  };
}

function markdown(
  report: AnalysisReport,
  ledger: Ledger,
  memo: DecisionMemo,
  implementation: ImplementationMap,
  preflight: Preflight,
  audit: LedgerAudit,
  claude: ClaudeReconstruction,
): string {
  const lines = [
    '# OpenChrome / Jev analysis report',
    '',
    `Generated: ${report.generated_at}`,
    '',
    `Verdict: ${report.verdict}`,
    '',
    '## Session Reconstruction',
    '',
    '- Source Claude session: `8f4f7598-99b4-44e8-98d4-b94e0188d1fa`.',
    '- The resumed work produced a gate ledger at `../openchrome-decider-ledger.json` and decision evidence under `artifacts/decision/`.',
    '- G0, G1, and G2 are closed in the ledger. G3 is open. S is pending because no real TypeSafe key is available.',
    '- The current branch/worktree contains uncommitted gate artifacts and code changes; do not treat this as a shipped PR.',
    `- Raw Claude reconstruction: ${claude.task_notifications.length} task notifications, ${claude.subagents.length} subagents, ${claude.task_notifications.filter((task) => task.status === 'failed').length} failed task notifications.`,
    `- Last Claude assistant response: ${claude.session.last_assistant_response ?? '-'}`,
    '',
    '## Gate Status',
    '',
    '| gate | state | closed at | evidence count |',
    '| --- | --- | --- | ---: |',
  ];
  for (const [name, gate] of Object.entries(report.gates)) {
    lines.push(`| ${name} | ${gate.state} | ${gate.closed_at ?? '-'} | ${gate.evidence_count} |`);
  }
  lines.push('', '## Ledger Audit', '');
  lines.push(`- Verdict: ${audit.ok ? 'ok' : 'not ok'}`);
  lines.push(`- Evidence entries checked: ${audit.evidence_count}`);
  lines.push(`- Missing evidence paths: ${audit.missing_evidence.length}`);
  lines.push(`- Bad status values: ${audit.bad_status_values.length}`);
  lines.push('', '## Current Decision', '', memo.summary, '');
  lines.push('| insertion | recommendation | B cases | regex accuracy | Jev | host |');
  lines.push('| --- | --- | ---: | ---: | --- | --- |');
  for (const insertion of memo.insertions) {
    lines.push(`| ${insertion.insertion} | ${insertion.recommendation} | ${insertion.b_cases} | ${insertion.current_regex_accuracy ?? '-'} | ${insertion.jev_status} | ${insertion.host_status} |`);
  }
  lines.push('', '## Jev Access Path', '');
  lines.push(`- Model available through Vercel AI Gateway: ${memo.gateway.jev_model_available ? 'yes' : 'no'}`);
  lines.push(`- Model id: \`${memo.gateway.model_id ?? '-'}\``);
  lines.push(`- Endpoint: \`${memo.gateway.endpoint ?? '-'}\``);
  lines.push(`- Key variable: \`${memo.gateway.key_variable ?? '-'}\``);
  lines.push('', '## Implementation Anchors', '');
  for (const item of implementation.maps) {
    lines.push(`### ${item.insertion}`, '');
    lines.push(`Status: ${item.implementation_status}`);
    lines.push('');
    lines.push(`Jev role: ${item.proposed_jev_role}`);
    lines.push('');
    lines.push('| path | symbol | evidence |');
    lines.push('| --- | --- | --- |');
    for (const anchor of item.primary_anchors) lines.push(`| \`${anchor.path}\` | \`${anchor.symbol}\` | \`${anchor.evidence}\` |`);
    lines.push('');
  }
  lines.push('## Closure Blockers', '');
  for (const check of preflight.checks.filter((item) => !item.ok)) lines.push(`- ${check.id}: ${check.detail}`);
  lines.push('', '## Pending Inputs', '');
  for (const pending of ledger.pending ?? []) lines.push(`- ${pending.item}: ${pending.reason}`);
  lines.push('', '## Next Action', '', ledger.next_action ?? '-', '');
  lines.push('## Do Not Claim', '');
  lines.push('- Do not claim TypeSafe/Jev improves OpenChrome until the Jev column has non-skipped B results.');
  lines.push('- Do not implement `element_search` routing until AX/CSS telemetry supports a frozen trigger.');
  lines.push('- Do not open go/no-go while `npm run preflight:g3` reports `ok_to_close: false`.');
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const ledger = readJson<Ledger>(ledgerPath);
  const memo = readJson<DecisionMemo>(path.join(outDir, 'decision-memo.json'));
  const implementation = readJson<ImplementationMap>(path.join(outDir, 'implementation-map.json'));
  const preflight = readJson<Preflight>(path.join(outDir, 'closure-preflight.json'));
  const audit = readJson<LedgerAudit>(path.join(outDir, 'ledger-audit.json'));
  const claude = readJson<ClaudeReconstruction>(path.join(outDir, 'claude-reconstruction.json'));
  const data = reportData(ledger, memo, preflight, audit, claude);
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.writeFileSync(reportPath, markdown(data, ledger, memo, implementation, preflight, audit, claude), 'utf8');
  console.log(JSON.stringify({ output: reportPath, verdict: data.verdict, candidates: data.current_candidates }, null, 2));
}

main();
