import * as fs from 'fs';
import * as path from 'path';

const outDir = path.join('artifacts', 'decision', 'G3');
const ledgerPath = path.join('..', 'openchrome-decider-ledger.json');
const jsonOut = path.join(outDir, 'completion-audit.json');
const mdOut = path.join(outDir, 'COMPLETION_AUDIT.md');

type AuditStatus = 'satisfied' | 'incomplete' | 'blocked_external';

interface CompletionRequirement {
  readonly id: string;
  readonly requirement: string;
  readonly status: AuditStatus;
  readonly evidence: readonly string[];
  readonly finding: string;
}

interface CompletionAudit {
  readonly generated_at: string;
  readonly verdict: 'goal_not_complete';
  readonly requirements: readonly CompletionRequirement[];
  readonly remaining_blockers: readonly string[];
  readonly next_action: string;
}

interface Preflight {
  readonly ok_to_close: boolean;
  readonly checks: readonly {
    readonly id: string;
    readonly ok: boolean;
    readonly evidence: string;
    readonly detail: string;
  }[];
}

interface AnalysisReport {
  readonly verdict: string;
  readonly current_candidates: readonly string[];
  readonly deferred_or_excluded: readonly string[];
  readonly ledger_audit_ok: boolean;
  readonly claude_reconstruction: {
    readonly task_notifications: number;
    readonly subagents: number;
    readonly failed_tasks: number;
  };
}

interface CommercialReport {
  readonly verdict: string;
  readonly recommended_sequence: readonly {
    readonly rank: number;
    readonly item: string;
  }[];
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function fileExists(file: string): boolean {
  return fs.existsSync(file);
}

function envSet(name: string): boolean {
  return typeof process.env[name] === 'string' && process.env[name]!.length > 0;
}

function modelColumnSatisfied(preflight: Preflight): boolean {
  const check = preflight.checks.find((item) => item.id === 'decision_model_column' || item.id === 'jev_column');
  return check?.ok === true;
}

function markdown(report: CompletionAudit): string {
  const lines = [
    '# G3 completion audit',
    '',
    `Generated: ${report.generated_at}`,
    '',
    `Verdict: ${report.verdict}`,
    '',
    '## Requirements',
    '',
    '| id | status | finding |',
    '| --- | --- | --- |',
  ];
  for (const item of report.requirements) {
    lines.push(`| ${item.id} | ${item.status} | ${item.finding.replace(/\|/g, '\\|')} |`);
  }
  lines.push('', '## Evidence', '');
  for (const item of report.requirements) {
    lines.push(`### ${item.id}: ${item.requirement}`, '');
    for (const evidence of item.evidence) lines.push(`- \`${evidence}\``);
    lines.push('');
  }
  lines.push('## Remaining Blockers', '');
  for (const blocker of report.remaining_blockers) lines.push(`- ${blocker}`);
  lines.push('', '## Next Action', '', report.next_action);
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const preflight = readJson<Preflight>(path.join(outDir, 'closure-preflight.json'));
  const analysis = readJson<AnalysisReport>(path.join(outDir, 'analysis-report.json'));
  const commercial = readJson<CommercialReport>(path.join(outDir, 'commercial-recommendations.json'));
  const failedChecks = preflight.checks.filter((check) => !check.ok);
  const jevKeySet = envSet('TYPESAFE_API_KEY') || envSet('AI_GATEWAY_API_KEY');
  const localModelEvidence = modelColumnSatisfied(preflight);
  const requirements: CompletionRequirement[] = [
    {
      id: 'claude-session-reconstruction',
      requirement: 'Read the named Claude session and subagent logs; reconstruct last messages, task notifications, changed files, branch, commit, and evidence files.',
      status: analysis.claude_reconstruction.task_notifications > 0 && analysis.claude_reconstruction.subagents > 0 ? 'satisfied' : 'incomplete',
      evidence: [
        'artifacts/decision/G3/CLAUDE_RECONSTRUCTION.md',
        'artifacts/decision/G3/claude-reconstruction.json',
      ],
      finding: `${analysis.claude_reconstruction.task_notifications} task notifications, ${analysis.claude_reconstruction.subagents} subagents, ${analysis.claude_reconstruction.failed_tasks} failed task notifications recorded.`,
    },
    {
      id: 'workspace-crosscheck',
      requirement: 'Cross-check current workspace and git status against reconstructed session state.',
      status: fileExists(ledgerPath) && analysis.ledger_audit_ok ? 'satisfied' : 'incomplete',
      evidence: [
        '../openchrome-decider-ledger.json',
        'artifacts/decision/G3/LEDGER_AUDIT.md',
        'artifacts/decision/G3/HANDOFF.md',
      ],
      finding: 'Current G3 ledger evidence exists and ledger audit reports missing evidence 0.',
    },
    {
      id: 'completed-analysis-summary',
      requirement: 'Summarize completed analysis and current candidates.',
      status: analysis.current_candidates.length > 0 ? 'satisfied' : 'incomplete',
      evidence: [
        'artifacts/decision/G3/ANALYSIS_REPORT.md',
        'artifacts/decision/G3/DECISION_MEMO.md',
        'artifacts/decision/G3/IMPLEMENTATION_MAP.md',
      ],
      finding: `Current candidates: ${analysis.current_candidates.join(', ')}; deferred/excluded: ${analysis.deferred_or_excluded.join(', ')}.`,
    },
    {
      id: 'commercial-recommendation',
      requirement: 'Answer which Jev/OpenChrome improvements are commercially plausible without over-claiming.',
      status: commercial.recommended_sequence.length > 0 ? 'satisfied' : 'incomplete',
      evidence: [
        'artifacts/decision/G3/COMMERCIAL_RECOMMENDATIONS.md',
        'artifacts/decision/G3/commercial-recommendations.json',
      ],
      finding: `${commercial.recommended_sequence.length} recommendations generated; verdict ${commercial.verdict}.`,
    },
    {
      id: 'g3-closure',
      requirement: 'Close G3 with threshold freeze, host answers, approval records, and Jev column.',
      status: preflight.ok_to_close ? 'satisfied' : 'blocked_external',
      evidence: [
        'artifacts/decision/G3/closure-preflight.json',
        'artifacts/decision/G3/freeze-gap-packet.json',
        'artifacts/decision/G3/host-answer-batch/validation-report.json',
        'artifacts/decision/G3/approval-validation-report.json',
        'artifacts/decision/G3/insertion-tables.json',
      ],
      finding: preflight.ok_to_close ? 'G3 preflight ok_to_close true.' : `G3 preflight remains open: ${failedChecks.map((check) => check.id).join(', ')}.`,
    },
    {
      id: 'real-jev-evidence',
      requirement: 'Run real TypeSafe/Jev, Vercel AI Gateway, or local Laya model evidence before claiming model improvement.',
      status: localModelEvidence ? 'satisfied' : jevKeySet ? 'incomplete' : 'blocked_external',
      evidence: [
        'artifacts/decision/G3/vercel-gateway/models-report.md',
        'artifacts/decision/G3/LAYA_LOCAL_SMOKE.md',
        'artifacts/decision/G3/insertion-tables.json',
      ],
      finding: localModelEvidence
        ? 'A non-skipped local Laya model column exists for the current outcome and irreversible candidates.'
        : jevKeySet ? 'A key is present but Jev evidence must be rerun.' : 'No remote key or local model column is present.',
    },
  ];
  const audit: CompletionAudit = {
    generated_at: new Date().toISOString(),
    verdict: 'goal_not_complete',
    requirements,
    remaining_blockers: failedChecks.map((check) => `${check.id}: ${check.detail}`),
    next_action: 'Collect approval records, host answers, AX/CSS telemetry or trigger revision, and gate exclusion approval or labeled gate cases before closing G3 or claiming model benefit.',
  };
  fs.writeFileSync(jsonOut, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdOut, markdown(audit), 'utf8');
  console.log(JSON.stringify({ output: mdOut, verdict: audit.verdict, blockers: audit.remaining_blockers.length }, null, 2));
}

main();
