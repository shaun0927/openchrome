import * as fs from 'fs';
import * as path from 'path';
import { parseCorpus } from '../../tests/fixtures/decisions/schema';
import type { DecisionCase, GateAnswer } from '../../tests/fixtures/decisions/schema';

const corpusPath = path.join('tests', 'fixtures', 'decisions', 'pool-fixture.labeled.jsonl');
const outDir = path.join('artifacts', 'decision', 'G3');
const jsonOut = path.join(outDir, 'gate-readiness.json');
const mdOut = path.join(outDir, 'GATE_READINESS.md');

const gateAnswers: readonly GateAnswer[] = ['bot_check', 'login', 'paywall', 'two_factor', 'none'];

interface GateReadiness {
  readonly generated_at: string;
  readonly corpus_path: string;
  readonly counts: {
    readonly gate_cases_total: number;
    readonly a_gate_cases: number;
    readonly b_gate_cases: number;
    readonly by_answer: Record<string, number>;
  };
  readonly source_anchors: readonly {
    readonly path: string;
    readonly evidence: string;
    readonly gate_answer: string;
  }[];
  readonly verdict: {
    readonly gate_detection_freezable: boolean;
    readonly recommendation: 'approve_exclusion' | 'add_labeled_cases';
    readonly reason: string;
  };
  readonly required_if_not_excluded: readonly string[];
}

function gateCases(cases: readonly DecisionCase[]): DecisionCase[] {
  return cases.filter((caseItem) => caseItem.kind === 'gate');
}

function labeledGateAnswer(caseItem: DecisionCase): string | null {
  return caseItem.kind === 'gate' ? caseItem.label?.answer ?? null : null;
}

function markdown(report: GateReadiness): string {
  const lines = [
    '# G3 gate readiness',
    '',
    `Generated: ${report.generated_at}`,
    '',
    `Verdict: ${report.verdict.gate_detection_freezable ? 'freezable' : 'not freezable'}`,
    '',
    `Recommendation: ${report.verdict.recommendation}`,
    '',
    report.verdict.reason,
    '',
    '## Counts',
    '',
  ];
  for (const [key, value] of Object.entries(report.counts)) {
    if (typeof value === 'number') lines.push(`- ${key}: ${value}`);
  }
  lines.push('', '## By Answer', '');
  for (const [answer, count] of Object.entries(report.counts.by_answer)) lines.push(`- ${answer}: ${count}`);
  lines.push('', '## Source Anchors', '');
  for (const anchor of report.source_anchors) {
    lines.push(`- ${anchor.gate_answer}: \`${anchor.path}\` / \`${anchor.evidence}\``);
  }
  lines.push('', '## Required If Not Excluded', '');
  for (const item of report.required_if_not_excluded) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const parsed = parseCorpus(fs.readFileSync(corpusPath, 'utf8'));
  if (parsed.errors.length > 0) throw new Error(`invalid corpus: ${JSON.stringify(parsed.errors)}`);
  const gates = gateCases(parsed.cases);
  const byAnswer = Object.fromEntries(gateAnswers.map((answer) => [answer, 0]));
  for (const item of gates) {
    const answer = labeledGateAnswer(item);
    if (answer) byAnswer[answer] = (byAnswer[answer] ?? 0) + 1;
  }
  const report: GateReadiness = {
    generated_at: new Date().toISOString(),
    corpus_path: corpusPath,
    counts: {
      gate_cases_total: gates.length,
      a_gate_cases: gates.filter((caseItem) => caseItem.split === 'A').length,
      b_gate_cases: gates.filter((caseItem) => caseItem.split === 'B').length,
      by_answer: byAnswer,
    },
    source_anchors: [
      { path: 'src/captcha/detect.ts', evidence: 'export async function detectCaptcha', gate_answer: 'bot_check' },
      { path: 'src/gates/detect-other-gates.ts', evidence: 'detectBotCheck', gate_answer: 'bot_check' },
      { path: 'src/gates/detect-other-gates.ts', evidence: 'detectSsoSignalFromUrl', gate_answer: 'login' },
      { path: 'src/gates/detect-other-gates.ts', evidence: 'detectPaywall', gate_answer: 'paywall' },
      { path: 'src/gates/detect-other-gates.ts', evidence: 'detectTwoFactor', gate_answer: 'two_factor' },
      { path: 'src/tools/login-detector.ts', evidence: 'export function classifyLoginSignals', gate_answer: 'login' },
    ],
    verdict: {
      gate_detection_freezable: false,
      recommendation: gates.length === 0 ? 'approve_exclusion' : 'add_labeled_cases',
      reason: gates.length === 0
        ? 'current labeled corpus has zero gate cases, so gate_detection cannot be frozen from evidence'
        : 'gate_detection has cases but still needs balanced A/B coverage before freeze',
    },
    required_if_not_excluded: [
      'Add labeled A gate cases for bot_check, login, paywall, two_factor, and none, or document why a class is out of G3 scope.',
      'Add B gate cases before go/no-go if gate_detection remains in scope.',
      'Rerun thresholds, freeze gaps, insertion tables, and preflight after adding cases.',
    ],
  };
  fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdOut, markdown(report), 'utf8');
  console.log(JSON.stringify({ output: mdOut, ...report.counts, recommendation: report.verdict.recommendation }, null, 2));
}

main();
