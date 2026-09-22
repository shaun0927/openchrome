/**
 * Decision-corpus evaluator library. The CLI wrapper is scripts/eval-decisions.ts.
 *
 * Scores providers on labeled cases only. Metrics: accuracy, abstain rate,
 * p50/p95 latency, and a 10-bin calibration table — overall and by kind,
 * lang, pool, split.
 *
 * Broken-input mode `remove-correct` deletes the labeled target from every
 * element view (expected answer becomes "none") and re-runs. A provider that
 * beat the noop baseline on the intact element cases must lose accuracy on
 * the broken ones; if it does not, the guard did not prove itself and
 * `runEvaluation` returns a non-zero exit code. `flip-labels` is rejected.
 */

import * as fs from 'fs';
import * as path from 'path';
import { NONE_ANSWER, parseCorpus } from '../../tests/fixtures/decisions/schema';
import type { CaseKind, DecisionCase, ElementCase } from '../../tests/fixtures/decisions/schema';
import { buildElementDecisionView } from '../../src/pilot/decider/view';
import { sha256Hex } from './split';
import { createProvider } from './providers';
import type { DecisionProvider, ProviderOptions } from './providers';

export type BrokenMode = 'remove-correct';
export type EvaluationViewMode = 'raw' | 'g2-element';
export const ACCEPTED_BROKEN_MODES: readonly BrokenMode[] = ['remove-correct'];
export const REJECTED_BROKEN_MODES: Record<string, string> = {
  'flip-labels': 'label flipping is not an accepted broken input: it changes the ground truth, not the input, so it measures the labels rather than the provider',
};

export interface CaseResult {
  id: string;
  kind: CaseKind;
  lang: string;
  pool: string;
  split: string;
  expected: string;
  answer: string;
  confidence: number;
  abstain: boolean;
  correct: boolean;
  latencyMs: number;
  error?: string;
  raw?: unknown;
}

export interface Metrics {
  count: number;
  correct: number;
  accuracy: number;
  abstain: number;
  abstainRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export interface CalibrationBin {
  bin: string;
  lo: number;
  hi: number;
  count: number;
  correct: number;
  accuracy: number | null;
  meanConfidence: number | null;
}

export interface ProviderReport {
  provider: string;
  generatedAt: string;
  corpusPath?: string;
  corpusSha256: string;
  broken: BrokenMode | null;
  viewMode: EvaluationViewMode;
  skipped?: string;
  totalCases: number;
  unlabeled: number;
  evaluated: number;
  errors: number;
  overall: Metrics;
  byKind: Record<string, Metrics>;
  byLang: Record<string, Metrics>;
  byPool: Record<string, Metrics>;
  bySplit: Record<string, Metrics>;
  calibration: CalibrationBin[];
  cases: CaseResult[];
}

export interface GuardFinding {
  provider: string;
  ok: boolean;
  message: string;
  intactElementAccuracy: number;
  brokenElementAccuracy: number;
  noopElementAccuracy: number;
  stillAnsweredRemovedRef: number;
}

export interface GuardResult {
  applicable: boolean;
  ok: boolean;
  findings: GuardFinding[];
  message: string;
}

// ─── metrics ───

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function computeMetrics(results: readonly CaseResult[]): Metrics {
  const count = results.length;
  const correct = results.filter((r) => r.correct).length;
  const abstain = results.filter((r) => r.abstain).length;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
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

function groupMetrics(results: readonly CaseResult[], key: (r: CaseResult) => string): Record<string, Metrics> {
  const groups = new Map<string, CaseResult[]>();
  for (const r of results) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const out: Record<string, Metrics> = {};
  for (const k of [...groups.keys()].sort()) out[k] = computeMetrics(groups.get(k)!);
  return out;
}

export function computeCalibration(results: readonly CaseResult[]): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < 10; i += 1) {
    const lo = i / 10;
    const hi = (i + 1) / 10;
    const inBin = results.filter((r) => (i === 9 ? r.confidence >= lo : r.confidence >= lo && r.confidence < hi));
    const correct = inBin.filter((r) => r.correct).length;
    bins.push({
      bin: `[${lo.toFixed(1)}, ${hi.toFixed(1)}${i === 9 ? ']' : ')'}`,
      lo,
      hi,
      count: inBin.length,
      correct,
      accuracy: inBin.length === 0 ? null : round(correct / inBin.length),
      meanConfidence: inBin.length === 0 ? null : round(inBin.reduce((s, r) => s + r.confidence, 0) / inBin.length),
    });
  }
  return bins;
}

// ─── broken input ───

/**
 * `remove-correct`: for element cases whose label is a ref, drop that target
 * from the view and set the expected answer to "none". Other kinds and
 * unlabeled cases pass through untouched. Never mutates the input.
 */
export function applyBrokenInput(cases: readonly DecisionCase[], mode: string): DecisionCase[] {
  if (mode in REJECTED_BROKEN_MODES) throw new Error(`--broken ${mode} rejected: ${REJECTED_BROKEN_MODES[mode]}`);
  if (!(ACCEPTED_BROKEN_MODES as readonly string[]).includes(mode)) {
    throw new Error(`unknown broken mode "${mode}" (accepted: ${ACCEPTED_BROKEN_MODES.join(', ')})`);
  }
  return cases.map((c) => {
    if (c.kind !== 'element' || !c.label || c.label.answer === NONE_ANSWER) return c;
    const removed = c.label.answer;
    const e: ElementCase = {
      ...c,
      input: { ...c.input, view: { ...c.input.view, targets: c.input.view.targets.filter((t) => t.ref !== removed) } },
      label: { ...c.label, answer: NONE_ANSWER, notes: `${c.label.notes ? `${c.label.notes}; ` : ''}broken:remove-correct removed ${removed}` },
      meta: { ...(c.meta ?? {}), broken: 'remove-correct', removed_ref: removed },
    };
    return e;
  });
}

// ─── evaluation ───

function stripTruth(c: DecisionCase): DecisionCase {
  const copy = { ...c } as DecisionCase & { label?: unknown; truth_hint?: unknown };
  delete copy.label;
  delete copy.truth_hint;
  return copy;
}

function normalizeAnswer(a: string): string {
  return a.trim();
}

export async function evaluateProvider(
  provider: DecisionProvider,
  cases: readonly DecisionCase[],
  opts: { broken?: BrokenMode | null; corpusPath?: string; viewMode?: EvaluationViewMode } = {},
): Promise<ProviderReport> {
  const viewMode = opts.viewMode ?? 'raw';
  const evaluationCases = applyViewMode(cases, viewMode);
  const corpusSha256 = sha256Hex(cases.map((c) => JSON.stringify(c)).join('\n'));
  const base = {
    provider: provider.name,
    generatedAt: new Date().toISOString(),
    corpusPath: opts.corpusPath,
    corpusSha256,
    broken: opts.broken ?? null,
    viewMode,
    totalCases: cases.length,
  };
  const init = provider.init ? await provider.init() : undefined;
  if (init && init.skipped) {
    const empty = computeMetrics([]);
    return {
      ...base, skipped: init.skipped, unlabeled: cases.filter((c) => !c.label).length, evaluated: 0, errors: 0,
      overall: empty, byKind: {}, byLang: {}, byPool: {}, bySplit: {}, calibration: computeCalibration([]), cases: [],
    };
  }

  const results: CaseResult[] = [];
  let unlabeled = 0;
  let errors = 0;
  for (const c of evaluationCases) {
    if (!c.label) { unlabeled += 1; continue; }
    const expected = normalizeAnswer(c.label.answer);
    const started = process.hrtime.bigint();
    let answer = NONE_ANSWER;
    let confidence = 0;
    let abstain = true;
    let error: string | undefined;
    let raw: unknown;
    try {
      const a = await provider.decide(stripTruth(c));
      answer = normalizeAnswer(a.answer);
      confidence = Math.max(0, Math.min(1, Number.isFinite(a.confidence) ? a.confidence : 0));
      abstain = a.abstain || answer === NONE_ANSWER;
      raw = a.raw;
    } catch (err) {
      error = (err as Error).message;
      errors += 1;
    }
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    results.push({
      id: c.id, kind: c.kind, lang: c.lang, pool: c.pool, split: c.split ?? 'unsplit',
      expected, answer, confidence, abstain, correct: error === undefined && answer === expected,
      latencyMs: round(latencyMs, 3), error, raw,
    });
  }

  return {
    ...base,
    unlabeled,
    evaluated: results.length,
    errors,
    overall: computeMetrics(results),
    byKind: groupMetrics(results, (r) => r.kind),
    byLang: groupMetrics(results, (r) => r.lang),
    byPool: groupMetrics(results, (r) => r.pool),
    bySplit: groupMetrics(results, (r) => r.split),
    calibration: computeCalibration(results),
    cases: results,
  };
}

export function applyViewMode(cases: readonly DecisionCase[], viewMode: EvaluationViewMode): DecisionCase[] {
  if (viewMode === 'raw') return [...cases];
  return cases.map((caseItem) => {
    if (caseItem.kind !== 'element') return caseItem;
    const built = buildElementDecisionView({
      id: caseItem.id,
      query: caseItem.input.query,
      targets: caseItem.input.view.targets,
      above: caseItem.input.view.above,
      below: caseItem.input.view.below,
      history: caseItem.input.view.history,
    });
    const refs = new Set(built.state.targets.map((target) => target.ref));
    const elementCase: ElementCase = {
      ...caseItem,
      input: {
        ...caseItem.input,
        view: {
          targets: caseItem.input.view.targets.filter((target) => refs.has(target.ref)),
          above: caseItem.input.view.above,
          below: caseItem.input.view.below,
          history: built.state.recent_history.map((entry) => ({ action: entry.action, result: entry.result })),
        },
      },
      meta: {
        ...(caseItem.meta ?? {}),
        decision_view: {
          mode: viewMode,
          byte_length: built.metrics.byte_length,
          max_bytes: built.metrics.max_bytes,
          target_count_total: built.metrics.target_count_total,
          target_count_included: built.metrics.target_count_included,
          omitted_targets: built.metrics.omitted_targets,
          history_count_included: built.metrics.history_count_included,
          omitted_history: built.metrics.omitted_history,
        },
      },
    };
    return elementCase;
  });
}

// ─── guard ───

function elementAccuracy(report: ProviderReport): number {
  return report.byKind.element?.accuracy ?? 0;
}

/**
 * The guard proves itself: a provider that beat noop on intact element cases
 * must score lower once the correct target is gone. Equal or higher accuracy
 * means the metric is not reading the view.
 */
export function checkRemoveCorrectGuard(
  intact: Record<string, ProviderReport>,
  broken: Record<string, ProviderReport>,
): GuardResult {
  const noop = intact.noop;
  if (!noop) return { applicable: false, ok: false, findings: [], message: 'guard needs the noop baseline in the intact run' };
  const applicableCases = Object.values(intact).some((r) => (r.byKind.element?.count ?? 0) > 0);
  if (!applicableCases) return { applicable: false, ok: true, findings: [], message: 'guard not applicable: no labeled element cases' };

  const noopAcc = elementAccuracy(noop);
  const findings: GuardFinding[] = [];
  for (const [name, report] of Object.entries(intact)) {
    if (name === 'noop' || report.skipped) continue;
    const brokenReport = broken[name];
    if (!brokenReport || brokenReport.skipped) continue;
    const intactAcc = elementAccuracy(report);
    const brokenAcc = elementAccuracy(brokenReport);
    const intactExpected = new Map(report.cases.map((c) => [c.id, c.expected]));
    const stillAnswered = brokenReport.cases.filter((c) => c.kind === 'element' && c.answer !== NONE_ANSWER && intactExpected.get(c.id) === c.answer).length;
    const aboveNoop = intactAcc > noopAcc;
    const dropped = brokenAcc < intactAcc;
    const ok = !aboveNoop || dropped;
    findings.push({
      provider: name,
      ok,
      intactElementAccuracy: intactAcc,
      brokenElementAccuracy: brokenAcc,
      noopElementAccuracy: noopAcc,
      stillAnsweredRemovedRef: stillAnswered,
      message: !aboveNoop
        ? `${name}: intact element accuracy ${intactAcc} does not beat noop ${noopAcc}; guard not applicable to this provider`
        : dropped
          ? `${name}: element accuracy dropped ${intactAcc} -> ${brokenAcc} after remove-correct (still answered the removed ref in ${stillAnswered} cases)`
          : `${name}: GUARD FAILED — element accuracy did not drop (${intactAcc} -> ${brokenAcc}) after the correct target was removed; the metric is not reading the view`,
    });
  }
  const ok = findings.every((f) => f.ok);
  return { applicable: true, ok, findings, message: ok ? 'remove-correct guard passed' : 'remove-correct guard FAILED' };
}

// ─── output ───

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function metricsRows(title: string, groups: Record<string, Metrics>): string[] {
  const rows = [`| ${title} | n | accuracy | abstain | p50 ms | p95 ms |`, '|---|---:|---:|---:|---:|---:|'];
  for (const [k, m] of Object.entries(groups)) {
    rows.push(`| ${k} | ${m.count} | ${pct(m.accuracy)} | ${pct(m.abstainRate)} | ${m.p50LatencyMs} | ${m.p95LatencyMs} |`);
  }
  return rows;
}

export function formatMarkdown(report: ProviderReport): string {
  const lines: string[] = [];
  lines.push(`## provider: ${report.provider}${report.broken ? ` (broken: ${report.broken})` : ''}`);
  if (report.skipped) {
    lines.push(`skipped: ${report.skipped}`);
    return lines.join('\n') + '\n';
  }
  lines.push(`cases: ${report.totalCases} total, ${report.evaluated} labeled/evaluated, ${report.unlabeled} unlabeled, ${report.errors} provider errors`);
  lines.push('');
  lines.push(...metricsRows('overall', { all: report.overall }));
  lines.push('');
  lines.push(...metricsRows('kind', report.byKind));
  lines.push('');
  lines.push(...metricsRows('lang', report.byLang));
  lines.push('');
  lines.push(...metricsRows('pool', report.byPool));
  lines.push('');
  lines.push(...metricsRows('split', report.bySplit));
  lines.push('');
  lines.push('| confidence bin | n | accuracy | mean conf |', '|---|---:|---:|---:|');
  for (const b of report.calibration) {
    lines.push(`| ${b.bin} | ${b.count} | ${b.accuracy === null ? '-' : pct(b.accuracy)} | ${b.meanConfidence === null ? '-' : b.meanConfidence.toFixed(2)} |`);
  }
  return lines.join('\n') + '\n';
}

// ─── driver ───

export interface RunOptions {
  corpusPath: string;
  providerNames: string[];
  outDir: string;
  broken?: string;
  providerOptions?: ProviderOptions;
  /** Test hook: supply providers by name instead of the registry. */
  providerFactory?: (name: string, opts: ProviderOptions) => DecisionProvider;
  /** Filters applied before evaluation. */
  kind?: CaseKind;
  split?: string;
  viewMode?: EvaluationViewMode;
  /** Where to print human output (default process.stdout / process.stderr). */
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface RunResult {
  exitCode: number;
  reports: Record<string, ProviderReport>;
  brokenReports: Record<string, ProviderReport>;
  guard?: GuardResult;
  messages: string[];
}

export async function runEvaluation(opts: RunOptions): Promise<RunResult> {
  const out = opts.stdout ?? ((t: string) => process.stdout.write(t));
  const err = opts.stderr ?? ((t: string) => process.stderr.write(t));
  const messages: string[] = [];
  const say = (m: string): void => { messages.push(m); err(m + '\n'); };

  if (opts.broken && opts.broken in REJECTED_BROKEN_MODES) {
    say(`--broken ${opts.broken} rejected: ${REJECTED_BROKEN_MODES[opts.broken]}`);
    return { exitCode: 2, reports: {}, brokenReports: {}, messages };
  }
  if (opts.broken && !(ACCEPTED_BROKEN_MODES as readonly string[]).includes(opts.broken)) {
    say(`unknown --broken mode "${opts.broken}" (accepted: ${ACCEPTED_BROKEN_MODES.join(', ')})`);
    return { exitCode: 2, reports: {}, brokenReports: {}, messages };
  }
  const broken = (opts.broken as BrokenMode | undefined) ?? null;

  if (!fs.existsSync(opts.corpusPath)) {
    say(`corpus not found: ${opts.corpusPath}`);
    return { exitCode: 2, reports: {}, brokenReports: {}, messages };
  }
  const parsed = parseCorpus(fs.readFileSync(opts.corpusPath, 'utf8'));
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) say(`${opts.corpusPath}:${e.line}: ${e.errors.join('; ')}`);
    return { exitCode: 2, reports: {}, brokenReports: {}, messages };
  }
  let cases = parsed.cases;
  if (opts.kind) cases = cases.filter((c) => c.kind === opts.kind);
  if (opts.split) cases = cases.filter((c) => c.split === opts.split);
  const labeled = cases.filter((c) => c.label).length;
  say(`corpus: ${cases.length} cases (${labeled} labeled) from ${opts.corpusPath}`);
  if (labeled === 0) say('no labeled cases: every provider will report zero evaluated cases');

  const names = [...opts.providerNames];
  if (broken && !names.includes('noop')) names.unshift('noop');
  const factory = opts.providerFactory ?? createProvider;
  const providerOptions = opts.providerOptions ?? {};

  fs.mkdirSync(opts.outDir, { recursive: true });
  const reports: Record<string, ProviderReport> = {};
  const brokenReports: Record<string, ProviderReport> = {};
  const viewMode = opts.viewMode ?? 'raw';
  const brokenCases = broken ? applyBrokenInput(cases, broken) : [];

  for (const name of names) {
    const provider = factory(name, providerOptions);
    try {
      const report = await evaluateProvider(provider, cases, { corpusPath: opts.corpusPath, viewMode });
      reports[name] = report;
      const file = path.join(opts.outDir, `eval-${name}.json`);
      fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
      if (report.skipped) say(`provider ${name}: skipped: ${report.skipped} (recorded in ${file})`);
      else say(`provider ${name}: ${report.evaluated} evaluated, accuracy ${pct(report.overall.accuracy)} -> ${file}`);
      out(formatMarkdown(report));
    } finally {
      await provider.close?.();
    }

    if (broken) {
      const brokenProvider = factory(name, providerOptions);
      try {
        const brokenReport = await evaluateProvider(brokenProvider, brokenCases, { corpusPath: opts.corpusPath, broken, viewMode });
        brokenReports[name] = brokenReport;
        const brokenFile = path.join(opts.outDir, `eval-${name}.broken-${broken}.json`);
        fs.writeFileSync(brokenFile, JSON.stringify(brokenReport, null, 2) + '\n', 'utf8');
        out(formatMarkdown(brokenReport));
      } finally {
        await brokenProvider.close?.();
      }
    }
  }

  let exitCode = 0;
  let guard: GuardResult | undefined;
  if (broken) {
    guard = checkRemoveCorrectGuard(reports, brokenReports);
    out(`\n## broken-input guard (${broken})\n\n`);
    for (const f of guard.findings) out(`- ${f.message}\n`);
    out(`\n${guard.message}\n`);
    say(guard.message);
    fs.writeFileSync(path.join(opts.outDir, `guard-${broken}.json`), JSON.stringify(guard, null, 2) + '\n', 'utf8');
    if (!guard.ok) exitCode = 1;
  }
  return { exitCode, reports, brokenReports, guard, messages };
}
