import * as fs from 'fs';
import * as path from 'path';
import type { CaseKind } from '../../tests/fixtures/decisions/schema';
import type { CaseResult, ProviderReport } from './evaluate';

const regexEvalPath = path.join('artifacts', 'decision', 'G0', 'eval-regex.json');
const outputPath = path.join('artifacts', 'decision', 'G3', 'threshold-candidates.json');

interface ThresholdCandidate {
  readonly insertion: string;
  readonly status: 'candidate' | 'fixed_rule' | 'missing_evidence';
  readonly trigger: string;
  readonly a_count: number;
  readonly a_accuracy: number | null;
  readonly candidate: unknown;
  readonly missing: readonly string[];
}

interface ThresholdReport {
  readonly generated_at: string;
  readonly source: {
    readonly regex_eval_path: string;
    readonly split: 'A';
  };
  readonly candidates: readonly ThresholdCandidate[];
  readonly notes: readonly string[];
}

function readReport(): ProviderReport {
  return JSON.parse(fs.readFileSync(regexEvalPath, 'utf8')) as ProviderReport;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function accuracy(cases: readonly CaseResult[]): number | null {
  if (cases.length === 0) return null;
  return round(cases.filter((caseItem) => caseItem.correct).length / cases.length);
}

function byKind(cases: readonly CaseResult[], kind: CaseKind): CaseResult[] {
  return cases.filter((caseItem) => caseItem.kind === kind);
}

function outcomeTriggerCases(cases: readonly CaseResult[]): CaseResult[] {
  return cases.filter((caseItem) => caseItem.answer === 'SILENT_CLICK' || caseItem.answer === 'WRONG_ELEMENT');
}

function bestElementConfidenceFloor(cases: readonly CaseResult[]): number | null {
  const candidates = [...new Set(cases.map((caseItem) => caseItem.confidence))].sort((a, b) => a - b);
  let best: { readonly floor: number; readonly accuracy: number; readonly count: number } | null = null;
  for (const floor of candidates) {
    const bucket = cases.filter((caseItem) => caseItem.confidence < floor);
    if (bucket.length === 0) continue;
    const bucketAccuracy = accuracy(bucket);
    if (bucketAccuracy === null) continue;
    if (!best || bucketAccuracy < best.accuracy || (bucketAccuracy === best.accuracy && bucket.length > best.count)) {
      best = { floor, accuracy: bucketAccuracy, count: bucket.length };
    }
  }
  return best?.floor ?? null;
}

function main(): void {
  const report = readReport();
  const aCases = report.cases.filter((caseItem) => caseItem.split === 'A');
  const elementCases = byKind(aCases, 'element');
  const outcomeCases = byKind(aCases, 'outcome');
  const irreversibleCases = byKind(aCases, 'irreversible');
  const gateCases = byKind(aCases, 'gate');
  const outcomeTriggers = outcomeTriggerCases(outcomeCases);
  const thresholdReport: ThresholdReport = {
    generated_at: new Date().toISOString(),
    source: {
      regex_eval_path: regexEvalPath,
      split: 'A',
    },
    candidates: [
      {
        insertion: 'element_search',
        status: 'missing_evidence',
        trigger: 'AX stage 3-4 or CSS score below frozen floor',
        a_count: elementCases.length,
        a_accuracy: accuracy(elementCases),
        candidate: {
          confidence_proxy_floor: bestElementConfidenceFloor(elementCases),
        },
        missing: ['A corpus does not record AX stage', 'A corpus does not record CSS score'],
      },
      {
        insertion: 'outcome_classification',
        status: 'candidate',
        trigger: 'regex answer is SILENT_CLICK or WRONG_ELEMENT',
        a_count: outcomeTriggers.length,
        a_accuracy: accuracy(outcomeTriggers),
        candidate: {
          answers: ['SILENT_CLICK', 'WRONG_ELEMENT'],
        },
        missing: [],
      },
      {
        insertion: 'irreversible_policy',
        status: 'fixed_rule',
        trigger: 'every mutation action before execution',
        a_count: irreversibleCases.length,
        a_accuracy: accuracy(irreversibleCases),
        candidate: {
          always_call_decider: true,
        },
        missing: [],
      },
      {
        insertion: 'gate_detection',
        status: gateCases.length === 0 ? 'missing_evidence' : 'candidate',
        trigger: 'regex gate detector returns none',
        a_count: gateCases.length,
        a_accuracy: accuracy(gateCases),
        candidate: {
          answer: 'none',
        },
        missing: gateCases.length === 0 ? ['A split has no gate cases'] : [],
      },
    ],
    notes: [
      'This file is a candidate freeze artifact, not final approval.',
      'All counts and accuracies are computed from the A split of the G0 regex evaluation.',
      'Element-search cannot be frozen to the spec trigger until AX stage and CSS score telemetry exist in the corpus or runtime records.',
    ],
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(thresholdReport, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: outputPath,
    candidates: thresholdReport.candidates.map((candidate) => ({
      insertion: candidate.insertion,
      status: candidate.status,
      a_count: candidate.a_count,
      a_accuracy: candidate.a_accuracy,
      missing: candidate.missing,
    })),
  }, null, 2));
}

main();
