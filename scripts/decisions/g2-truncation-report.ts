import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildElementDecisionView,
  decisionViewHasAnswer,
  DEFAULT_ELEMENT_DECISION_VIEW_LIMITS,
} from '../../src/pilot/decider/view';
import { NONE_ANSWER, parseCorpus, type DecisionCase, type ElementCase } from '../../tests/fixtures/decisions/schema';

const corpusPath = join('tests', 'fixtures', 'decisions', 'pool-fixture.labeled.jsonl');
const outputPath = join('artifacts', 'decision', 'G2', 'truncation-report.json');

interface CaseReport {
  readonly id: string;
  readonly label_answer: string;
  readonly byte_length: number;
  readonly target_count_total: number;
  readonly target_count_included: number;
  readonly omitted_targets: number;
  readonly answer_present: boolean;
}

interface TruncationReport {
  readonly generated_at: string;
  readonly corpus_path: string;
  readonly corpus_sha256: string;
  readonly split: 'B';
  readonly max_bytes: number;
  readonly max_targets: number;
  readonly history_limit: number;
  readonly evaluated_element_cases: number;
  readonly truncated_cases: number;
  readonly answer_truncated_cases: number;
  readonly answer_truncation_rate: number;
  readonly cases: readonly CaseReport[];
}

function elementCasesForSplitB(cases: readonly DecisionCase[]): ElementCase[] {
  return cases.filter((caseItem): caseItem is ElementCase => caseItem.kind === 'element' && caseItem.split === 'B');
}

function reportCase(caseItem: ElementCase): CaseReport {
  const answer = caseItem.label?.answer ?? NONE_ANSWER;
  const built = buildElementDecisionView({
    id: caseItem.id,
    query: caseItem.input.query,
    targets: caseItem.input.view.targets,
    above: caseItem.input.view.above,
    below: caseItem.input.view.below,
    history: caseItem.input.view.history,
  });
  const answerPresent = answer === NONE_ANSWER || decisionViewHasAnswer(built.question, answer);
  return {
    id: caseItem.id,
    label_answer: answer,
    byte_length: built.metrics.byte_length,
    target_count_total: built.metrics.target_count_total,
    target_count_included: built.metrics.target_count_included,
    omitted_targets: built.metrics.omitted_targets,
    answer_present: answerPresent,
  };
}

function main(): void {
  const corpusText = readFileSync(corpusPath, 'utf8');
  const parsed = parseCorpus(corpusText);
  if (parsed.errors.length > 0) {
    throw new Error(`invalid corpus: ${JSON.stringify(parsed.errors)}`);
  }
  const cases = elementCasesForSplitB(parsed.cases);
  const caseReports = cases.map(reportCase);
  const truncatedCases = caseReports.filter((caseItem) => caseItem.omitted_targets > 0).length;
  const answerTruncatedCases = caseReports.filter((caseItem) => !caseItem.answer_present).length;
  const report: TruncationReport = {
    generated_at: new Date().toISOString(),
    corpus_path: corpusPath,
    corpus_sha256: createHash('sha256').update(corpusText).digest('hex'),
    split: 'B',
    max_bytes: DEFAULT_ELEMENT_DECISION_VIEW_LIMITS.maxBytes,
    max_targets: DEFAULT_ELEMENT_DECISION_VIEW_LIMITS.maxTargets,
    history_limit: DEFAULT_ELEMENT_DECISION_VIEW_LIMITS.historyLimit,
    evaluated_element_cases: caseReports.length,
    truncated_cases: truncatedCases,
    answer_truncated_cases: answerTruncatedCases,
    answer_truncation_rate: caseReports.length === 0 ? 0 : answerTruncatedCases / caseReports.length,
    cases: caseReports,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: outputPath,
    evaluated_element_cases: report.evaluated_element_cases,
    truncated_cases: report.truncated_cases,
    answer_truncated_cases: report.answer_truncated_cases,
    answer_truncation_rate: report.answer_truncation_rate,
  }, null, 2));
}

main();
