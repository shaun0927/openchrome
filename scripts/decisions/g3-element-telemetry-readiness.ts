import * as fs from 'fs';
import * as path from 'path';
import { parseCorpus } from '../../tests/fixtures/decisions/schema';
import type { DecisionCase, ElementHistoryEntry } from '../../tests/fixtures/decisions/schema';

const corpusPath = path.join('tests', 'fixtures', 'decisions', 'pool-fixture.labeled.jsonl');
const outDir = path.join('artifacts', 'decision', 'G3');
const jsonOut = path.join(outDir, 'element-telemetry-readiness.json');
const mdOut = path.join(outDir, 'ELEMENT_TELEMETRY_READINESS.md');

interface ElementTelemetryCase {
  readonly id: string;
  readonly split: string;
  readonly history_entries: number;
  readonly has_ax_match_level: boolean;
  readonly has_css_score: boolean;
  readonly missing: readonly string[];
}

interface ElementTelemetryReadiness {
  readonly generated_at: string;
  readonly corpus_path: string;
  readonly contract: {
    readonly schema_field: 'input.view.history[].resolution';
    readonly ax_field: 'ax_match_level';
    readonly css_field: 'css_score';
    readonly source_anchors: readonly {
      readonly path: string;
      readonly evidence: string;
    }[];
  };
  readonly counts: {
    readonly a_element_cases: number;
    readonly a_cases_with_ax_match_level: number;
    readonly a_cases_with_css_score: number;
    readonly a_cases_ready: number;
  };
  readonly cases: readonly ElementTelemetryCase[];
  readonly verdict: {
    readonly element_search_threshold_ready: boolean;
    readonly reason: string;
  };
}

function elementCases(cases: readonly DecisionCase[]): DecisionCase[] {
  return cases.filter((caseItem) => caseItem.kind === 'element' && caseItem.split === 'A');
}

function hasAxMatchLevel(history: readonly ElementHistoryEntry[]): boolean {
  return history.some((entry) => typeof entry.resolution?.ax_match_level === 'number');
}

function hasCssScore(history: readonly ElementHistoryEntry[]): boolean {
  return history.some((entry) => typeof entry.resolution?.css_score === 'number');
}

function caseReadiness(caseItem: DecisionCase): ElementTelemetryCase {
  if (caseItem.kind !== 'element') throw new Error(`not an element case: ${caseItem.id}`);
  const history = caseItem.input.view.history;
  const hasAx = hasAxMatchLevel(history);
  const hasCss = hasCssScore(history);
  const missing = [
    ...(hasAx ? [] : ['ax_match_level']),
    ...(hasCss ? [] : ['css_score']),
  ];
  return {
    id: caseItem.id,
    split: caseItem.split ?? 'unsplit',
    history_entries: history.length,
    has_ax_match_level: hasAx,
    has_css_score: hasCss,
    missing,
  };
}

function markdown(report: ElementTelemetryReadiness): string {
  const lines = [
    '# G3 element telemetry readiness',
    '',
    `Generated: ${report.generated_at}`,
    '',
    `Verdict: ${report.verdict.element_search_threshold_ready ? 'ready' : 'not ready'}`,
    '',
    report.verdict.reason,
    '',
    '## Contract',
    '',
    `- Schema field: \`${report.contract.schema_field}\``,
    `- AX field: \`${report.contract.ax_field}\``,
    `- CSS field: \`${report.contract.css_field}\``,
    '',
    '## Source Anchors',
    '',
  ];
  for (const anchor of report.contract.source_anchors) lines.push(`- \`${anchor.path}\`: \`${anchor.evidence}\``);
  lines.push('', '## Counts', '');
  for (const [key, value] of Object.entries(report.counts)) lines.push(`- ${key}: ${value}`);
  lines.push('', '## Missing Cases', '');
  for (const item of report.cases.filter((caseItem) => caseItem.missing.length > 0)) {
    lines.push(`- \`${item.id}\`: ${item.missing.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const parsed = parseCorpus(fs.readFileSync(corpusPath, 'utf8'));
  if (parsed.errors.length > 0) throw new Error(`invalid corpus: ${JSON.stringify(parsed.errors)}`);
  const cases = elementCases(parsed.cases).map(caseReadiness);
  const ready = cases.filter((caseItem) => caseItem.missing.length === 0);
  const report: ElementTelemetryReadiness = {
    generated_at: new Date().toISOString(),
    corpus_path: corpusPath,
    contract: {
      schema_field: 'input.view.history[].resolution',
      ax_field: 'ax_match_level',
      css_field: 'css_score',
      source_anchors: [
        { path: 'src/tools/interact.ts', evidence: 'MATCH_LEVEL_LABELS[ax.matchLevel]' },
        { path: 'src/tools/interact.ts', evidence: 'bestMatch.score < 50' },
        { path: 'src/recovery/ralph/ralph-engine.ts', evidence: 'MATCH_LEVEL_LABELS[ax.matchLevel]' },
        { path: 'src/recovery/ralph/ralph-engine.ts', evidence: 'scoreElement(el as FoundElement' },
      ],
    },
    counts: {
      a_element_cases: cases.length,
      a_cases_with_ax_match_level: cases.filter((caseItem) => caseItem.has_ax_match_level).length,
      a_cases_with_css_score: cases.filter((caseItem) => caseItem.has_css_score).length,
      a_cases_ready: ready.length,
    },
    cases,
    verdict: {
      element_search_threshold_ready: cases.length > 0 && ready.length === cases.length,
      reason: ready.length === cases.length
        ? 'every A element case carries AX match level and CSS score telemetry'
        : 'A element cases still lack AX match level and CSS score telemetry required to freeze element_search',
    },
  };
  fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdOut, markdown(report), 'utf8');
  console.log(JSON.stringify({ output: mdOut, ...report.counts, ready: report.verdict.element_search_threshold_ready }, null, 2));
}

main();
