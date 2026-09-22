import * as fs from 'fs';
import * as path from 'path';
import type { CaseKind } from '../../tests/fixtures/decisions/schema';
import type { CaseResult, Metrics, ProviderReport } from './evaluate';

const outDir = path.join('artifacts', 'decision', 'G3');
const thresholdPath = path.join(outDir, 'threshold-candidates.json');

interface ThresholdCandidate {
  readonly insertion: string;
  readonly status: string;
  readonly trigger: string;
  readonly missing: readonly string[];
}

interface ProviderCell {
  readonly provider: string;
  readonly role: string;
  readonly status: 'ok' | 'skipped' | 'missing';
  readonly count: number;
  readonly accuracy: number | null;
  readonly abstain_rate: number | null;
  readonly p50_latency_ms: number | null;
  readonly p95_latency_ms: number | null;
  readonly note: string | null;
}

interface InsertionTable {
  readonly insertion: string;
  readonly trigger: string;
  readonly threshold_status: string;
  readonly threshold_missing: readonly string[];
  readonly case_ids: readonly string[];
  readonly providers: readonly ProviderCell[];
}

interface InsertionTablesReport {
  readonly generated_at: string;
  readonly source_reports: readonly string[];
  readonly tables: readonly InsertionTable[];
  readonly notes: readonly string[];
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readReport(name: string): ProviderReport | null {
  const file = path.join(outDir, `eval-${name}.json`);
  if (!fs.existsSync(file)) return null;
  return readJson(file) as ProviderReport;
}

function readThresholds(): ThresholdCandidate[] {
  const parsed = readJson(thresholdPath);
  if (typeof parsed !== 'object' || parsed === null || !('candidates' in parsed)) return [];
  const candidates = (parsed as { readonly candidates?: unknown }).candidates;
  return Array.isArray(candidates) ? candidates.filter(isThresholdCandidate) : [];
}

function isThresholdCandidate(value: unknown): value is ThresholdCandidate {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.insertion === 'string'
    && typeof item.status === 'string'
    && typeof item.trigger === 'string'
    && Array.isArray(item.missing)
    && item.missing.every((missing) => typeof missing === 'string');
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function metrics(cases: readonly CaseResult[]): Metrics {
  const count = cases.length;
  const correct = cases.filter((caseItem) => caseItem.correct).length;
  const abstain = cases.filter((caseItem) => caseItem.abstain).length;
  const latencies = cases.map((caseItem) => caseItem.latencyMs).sort((left, right) => left - right);
  return {
    count,
    correct,
    accuracy: count === 0 ? 0 : round(correct / count),
    abstain,
    abstainRate: count === 0 ? 0 : round(abstain / count),
    p50LatencyMs: round(percentile(latencies, 50), 3),
    p95LatencyMs: round(percentile(latencies, 95), 3),
  };
}

function insertionIds(regex: ProviderReport, insertion: string): string[] {
  switch (insertion) {
    case 'element_search':
      return ids(regex.cases.filter((caseItem) => caseItem.kind === 'element'));
    case 'outcome_classification':
      return ids(regex.cases.filter((caseItem) => caseItem.kind === 'outcome' && (caseItem.answer === 'SILENT_CLICK' || caseItem.answer === 'WRONG_ELEMENT')));
    case 'irreversible_policy':
      return ids(regex.cases.filter((caseItem) => caseItem.kind === 'irreversible'));
    case 'gate_detection':
      return ids(regex.cases.filter((caseItem) => caseItem.kind === 'gate' && caseItem.answer === 'none'));
    default:
      return [];
  }
}

function ids(cases: readonly CaseResult[]): string[] {
  return cases.map((caseItem) => caseItem.id).sort();
}

function summarize(report: ProviderReport | null, provider: string, role: string, caseIds: readonly string[]): ProviderCell {
  if (!report) {
    return {
      provider,
      role,
      status: 'missing',
      count: 0,
      accuracy: null,
      abstain_rate: null,
      p50_latency_ms: null,
      p95_latency_ms: null,
      note: provider === 'file' ? 'no host answers file supplied' : 'provider report missing',
    };
  }
  if (report.skipped) {
    return {
      provider,
      role,
      status: 'skipped',
      count: 0,
      accuracy: null,
      abstain_rate: null,
      p50_latency_ms: null,
      p95_latency_ms: null,
      note: report.skipped,
    };
  }
  const set = new Set(caseIds);
  const subset = report.cases.filter((caseItem) => set.has(caseItem.id));
  const current = metrics(subset);
  const errors = subset.filter((caseItem) => caseItem.error).length;
  return {
    provider,
    role,
    status: 'ok',
    count: current.count,
    accuracy: current.accuracy,
    abstain_rate: current.abstainRate,
    p50_latency_ms: current.p50LatencyMs,
    p95_latency_ms: current.p95LatencyMs,
    note: errors > 0 ? `provider errors: ${errors}` : null,
  };
}

function fmt(value: number | null): string {
  return value === null ? '-' : String(value);
}

function markdown(report: InsertionTablesReport): string {
  const lines = ['# G3 insertion tables', '', `Generated: ${report.generated_at}`, ''];
  for (const table of report.tables) {
    lines.push(`## ${table.insertion}`, '');
    lines.push(`Trigger: ${table.trigger}`);
    lines.push('');
    lines.push(`Threshold status: ${table.threshold_status}${table.threshold_missing.length > 0 ? ` (${table.threshold_missing.join('; ')})` : ''}`);
    lines.push('');
    lines.push(`B trigger cases: ${table.case_ids.length}`);
    lines.push('');
    lines.push('| role | provider | status | n | accuracy | abstain | p50 ms | p95 ms | note |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const provider of table.providers) {
      lines.push(`| ${provider.role} | ${provider.provider} | ${provider.status} | ${provider.count} | ${fmt(provider.accuracy)} | ${fmt(provider.abstain_rate)} | ${fmt(provider.p50_latency_ms)} | ${fmt(provider.p95_latency_ms)} | ${provider.note ?? ''} |`);
    }
    lines.push('');
  }
  lines.push('## Notes', '');
  for (const note of report.notes) lines.push(`- ${note}`);
  return `${lines.join('\n')}\n`;
}

function requiredKindForInsertion(insertion: string): CaseKind | null {
  if (insertion === 'element_search') return 'element';
  if (insertion === 'outcome_classification') return 'outcome';
  if (insertion === 'irreversible_policy') return 'irreversible';
  if (insertion === 'gate_detection') return 'gate';
  return null;
}

function main(): void {
  const reports = {
    noop: readReport('noop'),
    file: readReport('file'),
    typesafe: readReport('typesafe'),
    layaLocal: readReport('laya-local'),
    regex: readReport('regex'),
  };
  if (!reports.regex) throw new Error('artifacts/decision/G3/eval-regex.json is required');
  const regexReport = reports.regex;
  const thresholds = new Map(readThresholds().map((candidate) => [candidate.insertion, candidate]));
  const insertions = ['element_search', 'outcome_classification', 'irreversible_policy', 'gate_detection'];
  const tables = insertions.map((insertion): InsertionTable => {
    const threshold = thresholds.get(insertion);
    const caseIds = insertionIds(regexReport, insertion);
    const requiredKind = requiredKindForInsertion(insertion);
    if (requiredKind === null) throw new Error(`unknown insertion: ${insertion}`);
    return {
      insertion,
      trigger: threshold?.trigger ?? 'missing threshold candidate',
      threshold_status: threshold?.status ?? 'missing_threshold',
      threshold_missing: threshold?.missing ?? ['threshold candidate missing'],
      case_ids: caseIds,
      providers: [
        summarize(reports.noop, 'noop', 'no-op', caseIds),
        summarize(reports.file, 'file', 'host-file', caseIds),
        summarize(reports.typesafe, 'typesafe', 'Jev', caseIds),
        summarize(reports.layaLocal, 'laya-local', 'local-model', caseIds),
        summarize(regexReport, 'regex', 'current-regex', caseIds),
      ],
    };
  });
  const sourceReports = ['noop', 'file', 'typesafe', 'laya-local', 'regex']
    .map((name) => path.join(outDir, `eval-${name}.json`))
    .filter((file) => fs.existsSync(file));
  const report: InsertionTablesReport = {
    generated_at: new Date().toISOString(),
    source_reports: sourceReports,
    tables,
    notes: [
      'Tables are split by the four allowed insertion points from the decision goal.',
      'host-file is missing unless npm run evidence:g3 is executed with --host-answers or HOST_DECISION_ANSWERS.',
      'Jev remains skipped when TYPESAFE_API_KEY is absent.',
      'laya-local is an opt-in local model column and remains missing unless LAYA_LOCAL_ENABLED=1 evidence is generated.',
      'current-regex is included as the existing baseline diagnostic, not as the required host or Jev column.',
    ],
  };
  fs.writeFileSync(path.join(outDir, 'insertion-tables.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDir, 'insertion-tables.md'), markdown(report), 'utf8');
  console.log(JSON.stringify({
    output: path.join(outDir, 'insertion-tables.json'),
    tables: report.tables.map((table) => ({
      insertion: table.insertion,
      cases: table.case_ids.length,
      threshold_status: table.threshold_status,
      threshold_missing: table.threshold_missing,
    })),
  }, null, 2));
}

main();
