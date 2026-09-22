import * as fs from 'fs';
import * as path from 'path';
import type { DecisionCase } from '../../tests/fixtures/decisions/schema';
import { parseCorpus } from '../../tests/fixtures/decisions/schema';
import type { CaseResult, ProviderReport } from './evaluate';

const corpusPath = path.join('tests', 'fixtures', 'decisions', 'pool-fixture.labeled.jsonl');
const frozenPath = path.join('artifacts', 'decision', 'frozen-thresholds.json');
const candidatesPath = path.join('artifacts', 'decision', 'G3', 'threshold-candidates.json');
const regexEvalPath = path.join('artifacts', 'decision', 'G0', 'eval-regex.json');
const elementTelemetryPath = path.join('artifacts', 'decision', 'G3', 'element-telemetry-readiness.json');
const gateReadinessPath = path.join('artifacts', 'decision', 'G3', 'gate-readiness.json');
const outputJsonPath = path.join('artifacts', 'decision', 'G3', 'freeze-gap-packet.json');
const outputMdPath = path.join('artifacts', 'decision', 'G3', 'freeze-gap-packet.md');

interface ThresholdCandidate {
  readonly insertion: string;
  readonly status: string;
  readonly trigger: string;
  readonly a_count: number;
  readonly a_accuracy: number | null;
  readonly candidate: unknown;
  readonly missing: readonly string[];
}

interface FreezeGap {
  readonly insertion: string;
  readonly current_frozen_trigger: string | null;
  readonly a_candidate_trigger: string | null;
  readonly status: string;
  readonly a_count: number;
  readonly a_accuracy: number | null;
  readonly missing: readonly string[];
  readonly available_proxy_evidence: unknown;
  readonly required_next_evidence: readonly string[];
}

interface FreezeGapPacket {
  readonly generated_at: string;
  readonly sources: {
    readonly corpus_path: string;
    readonly frozen_thresholds_path: string;
    readonly threshold_candidates_path: string;
    readonly regex_eval_path: string;
    readonly element_telemetry_readiness_path: string;
    readonly gate_readiness_path: string;
  };
  readonly corpus_counts: Record<string, number>;
  readonly gaps: readonly FreezeGap[];
  readonly verdict: {
    readonly can_close_g3_threshold_freeze: boolean;
    readonly reason: string;
  };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCandidates(): ThresholdCandidate[] {
  const parsed = readJson(candidatesPath);
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) return [];
  return parsed.candidates.filter((candidate): candidate is ThresholdCandidate => {
    if (!isRecord(candidate)) return false;
    return typeof candidate.insertion === 'string'
      && typeof candidate.status === 'string'
      && typeof candidate.trigger === 'string'
      && typeof candidate.a_count === 'number'
      && (typeof candidate.a_accuracy === 'number' || candidate.a_accuracy === null)
      && Array.isArray(candidate.missing)
      && candidate.missing.every((item) => typeof item === 'string');
  });
}

function readCorpus(): DecisionCase[] {
  const parsed = parseCorpus(fs.readFileSync(corpusPath, 'utf8'));
  if (parsed.errors.length > 0) throw new Error(`invalid corpus: ${JSON.stringify(parsed.errors)}`);
  return parsed.cases;
}

function countCases(cases: readonly DecisionCase[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const caseItem of cases) {
    const key = `${caseItem.split ?? 'unsplit'}:${caseItem.kind}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function frozenTrigger(frozen: unknown, insertion: string): string | null {
  if (!isRecord(frozen) || !isRecord(frozen.insertion_triggers)) return null;
  const triggers = frozen.insertion_triggers;
  const key = insertion === 'element_search'
    ? 'element'
    : insertion === 'outcome_classification'
      ? 'outcome'
      : insertion === 'irreversible_policy'
        ? 'irreversible'
        : insertion === 'gate_detection'
          ? 'gate'
          : insertion;
  const value = triggers[key];
  return typeof value === 'string' ? value : null;
}

function regexScoreProxy(report: ProviderReport): unknown {
  const elementA = report.cases.filter((caseItem) => caseItem.split === 'A' && caseItem.kind === 'element');
  const bestScores = elementA.flatMap((caseItem) => bestRegexScore(caseItem));
  if (bestScores.length === 0) return { note: 'no A element regex scores found' };
  return {
    warning: 'regex scores are element-finder scores, not CSS scores; do not use them as CSS threshold evidence',
    a_element_cases: elementA.length,
    best_score_min: Math.min(...bestScores),
    best_score_max: Math.max(...bestScores),
    best_score_below_50: bestScores.filter((score) => score < 50).length,
  };
}

function elementTelemetryReadiness(): unknown {
  return readJson(elementTelemetryPath);
}

function bestRegexScore(caseItem: CaseResult): number[] {
  if (!isRecord(caseItem.raw) || !isRecord(caseItem.raw.scores)) return [];
  const scores = Object.values(caseItem.raw.scores).filter((score): score is number => typeof score === 'number');
  return scores.length === 0 ? [] : [Math.max(...scores)];
}

function gateProxy(cases: readonly DecisionCase[]): unknown {
  const gateCases = cases.filter((caseItem) => caseItem.kind === 'gate');
  return {
    gate_readiness: readJson(gateReadinessPath),
    corpus_gate_cases_total: gateCases.length,
    a_gate_cases: gateCases.filter((caseItem) => caseItem.split === 'A').length,
    b_gate_cases: gateCases.filter((caseItem) => caseItem.split === 'B').length,
  };
}

function gapFor(
  candidate: ThresholdCandidate,
  frozen: unknown,
  cases: readonly DecisionCase[],
  regexReport: ProviderReport,
): FreezeGap {
  const missing = candidate.insertion === 'gate_detection' && gateProxy(cases)
    ? candidate.missing
    : candidate.missing;
  return {
    insertion: candidate.insertion,
    current_frozen_trigger: frozenTrigger(frozen, candidate.insertion),
    a_candidate_trigger: candidate.trigger,
    status: candidate.status,
    a_count: candidate.a_count,
    a_accuracy: candidate.a_accuracy,
    missing,
    available_proxy_evidence: candidate.insertion === 'element_search'
      ? {
        telemetry_readiness: elementTelemetryReadiness(),
        regex_score_proxy: regexScoreProxy(regexReport),
      }
      : candidate.insertion === 'gate_detection'
        ? gateProxy(cases)
        : { candidate: candidate.candidate },
    required_next_evidence: requiredEvidence(candidate.insertion, candidate.missing),
  };
}

function requiredEvidence(insertion: string, missing: readonly string[]): readonly string[] {
  if (insertion === 'element_search') {
    return [
      'A-run records containing AX cascade level for each element-search decision point',
      'A-run records containing CSS score for each element-search decision point',
      'Approval record freezing the derived element trigger from A only',
    ];
  }
  if (insertion === 'gate_detection') {
    return [
      'A-split gate cases labeled by the label session, or an explicit approved exclusion of gate_detection from G3',
      'B-split gate cases before go/no-go if gate_detection remains in scope',
    ];
  }
  if (missing.length === 0) return ['Approval record freezing this candidate from A'];
  return missing;
}

function markdown(packet: FreezeGapPacket): string {
  const lines = [
    '# G3 freeze gap packet',
    '',
    `Generated: ${packet.generated_at}`,
    '',
    `Verdict: ${packet.verdict.can_close_g3_threshold_freeze ? 'can close' : 'cannot close'}`,
    '',
    packet.verdict.reason,
    '',
    '## Corpus counts',
    '',
    '| bucket | count |',
    '| --- | ---: |',
  ];
  for (const [bucket, count] of Object.entries(packet.corpus_counts).sort()) {
    lines.push(`| ${bucket} | ${count} |`);
  }
  lines.push('', '## Gaps', '');
  for (const gap of packet.gaps) {
    lines.push(`### ${gap.insertion}`, '');
    lines.push(`Current frozen trigger: ${gap.current_frozen_trigger ?? '-'}`);
    lines.push('');
    lines.push(`A candidate trigger: ${gap.a_candidate_trigger ?? '-'}`);
    lines.push('');
    lines.push(`Status: ${gap.status}`);
    lines.push('');
    lines.push(`A count: ${gap.a_count}`);
    lines.push('');
    lines.push(`A accuracy: ${gap.a_accuracy ?? '-'}`);
    lines.push('');
    lines.push(`Missing: ${gap.missing.length === 0 ? '-' : gap.missing.join('; ')}`);
    lines.push('');
    lines.push('Required next evidence:');
    lines.push('');
    for (const evidence of gap.required_next_evidence) lines.push(`- ${evidence}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const cases = readCorpus();
  const frozen = readJson(frozenPath);
  const candidates = readCandidates();
  const regexReport = readJson(regexEvalPath) as ProviderReport;
  const gaps = candidates.map((candidate) => gapFor(candidate, frozen, cases, regexReport));
  const openGaps = gaps.filter((gap) => gap.status === 'missing_evidence' || gap.missing.length > 0);
  const packet: FreezeGapPacket = {
    generated_at: new Date().toISOString(),
    sources: {
      corpus_path: corpusPath,
      frozen_thresholds_path: frozenPath,
      threshold_candidates_path: candidatesPath,
      regex_eval_path: regexEvalPath,
      element_telemetry_readiness_path: elementTelemetryPath,
      gate_readiness_path: gateReadinessPath,
    },
    corpus_counts: countCases(cases),
    gaps,
    verdict: {
      can_close_g3_threshold_freeze: openGaps.length === 0,
      reason: openGaps.length === 0
        ? 'All G3 threshold candidates have A-derived evidence.'
        : `${openGaps.length} threshold gap(s) remain: ${openGaps.map((gap) => gap.insertion).join(', ')}`,
    },
  };
  fs.writeFileSync(outputJsonPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
  fs.writeFileSync(outputMdPath, markdown(packet), 'utf8');
  console.log(JSON.stringify({
    output: outputJsonPath,
    can_close_g3_threshold_freeze: packet.verdict.can_close_g3_threshold_freeze,
    open_gaps: openGaps.map((gap) => gap.insertion),
  }, null, 2));
}

main();
