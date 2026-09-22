import * as fs from 'fs';
import * as path from 'path';
import { runEvaluation, type ProviderReport } from './evaluate';

const corpusPath = path.join('tests', 'fixtures', 'decisions', 'pool-fixture.labeled.jsonl');
const outDir = path.join('artifacts', 'decision', 'G3');
const baselineDir = path.join('artifacts', 'decision', 'G0');

interface ProviderSummary {
  readonly provider: string;
  readonly role: string;
  readonly skipped: string | null;
  readonly evaluated: number;
  readonly accuracy: number | null;
  readonly p50_latency_ms: number | null;
  readonly p95_latency_ms: number | null;
  readonly baseline_accuracy: number | null;
  readonly accuracy_delta_pp: number | null;
  readonly p50_latency_delta_ms: number | null;
}

interface G3Summary {
  readonly generated_at: string;
  readonly corpus_path: string;
  readonly split: 'B';
  readonly view_mode: 'g2-element';
  readonly host_answers_path: string | null;
  readonly providers: readonly ProviderSummary[];
  readonly notes: readonly string[];
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readBaseline(provider: string): ProviderReport | null {
  const file = path.join(baselineDir, `eval-${provider}.json`);
  if (!fs.existsSync(file)) return null;
  return readJson(file) as ProviderReport;
}

function roleFor(provider: string): string {
  if (provider === 'noop') return 'no-op';
  if (provider === 'file') return 'host-file';
  if (provider === 'typesafe') return 'Jev';
  if (provider === 'laya-local') return 'local-model';
  return 'current-regex';
}

function metricOrNull(value: number | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function summarize(provider: string, report: ProviderReport, baseline: ProviderReport | null): ProviderSummary {
  const currentAccuracy = report.skipped ? null : report.overall.accuracy;
  const currentP50 = report.skipped ? null : report.overall.p50LatencyMs;
  const baselineB = baseline?.bySplit.B;
  const baselineAccuracy = baselineB ? baselineB.accuracy : null;
  const baselineP50 = baselineB ? baselineB.p50LatencyMs : null;
  return {
    provider,
    role: roleFor(provider),
    skipped: report.skipped ?? null,
    evaluated: report.evaluated,
    accuracy: currentAccuracy,
    p50_latency_ms: report.skipped ? null : metricOrNull(report.overall.p50LatencyMs),
    p95_latency_ms: report.skipped ? null : metricOrNull(report.overall.p95LatencyMs),
    baseline_accuracy: baselineAccuracy,
    accuracy_delta_pp: currentAccuracy === null || baselineAccuracy === null ? null : round((currentAccuracy - baselineAccuracy) * 100),
    p50_latency_delta_ms: currentP50 === null || baselineP50 === null ? null : round(currentP50 - baselineP50),
  };
}

function fmt(value: number | null, suffix = ''): string {
  return value === null ? '-' : `${value}${suffix}`;
}

function markdown(summary: G3Summary): string {
  const lines = [
    '# G3 B view evaluation',
    '',
    `Generated: ${summary.generated_at}`,
    '',
    `Corpus: \`${summary.corpus_path}\``,
    '',
    `View mode: \`${summary.view_mode}\``,
    '',
    '| role | provider | evaluated | accuracy | baseline B accuracy | delta pp | p50 ms | p50 delta ms | skipped |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const provider of summary.providers) {
    lines.push(`| ${provider.role} | ${provider.provider} | ${provider.evaluated} | ${fmt(provider.accuracy)} | ${fmt(provider.baseline_accuracy)} | ${fmt(provider.accuracy_delta_pp)} | ${fmt(provider.p50_latency_ms)} | ${fmt(provider.p50_latency_delta_ms)} | ${provider.skipped ?? ''} |`);
  }
  lines.push('', '## Notes', '');
  for (const note of summary.notes) lines.push(`- ${note}`);
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const hostAnswersPath = argValue('--host-answers') ?? process.env.HOST_DECISION_ANSWERS;
  const modelProviders = process.env.LAYA_LOCAL_ENABLED === '1' ? ['typesafe', 'laya-local'] : ['typesafe'];
  const providers = hostAnswersPath ? ['noop', 'file', ...modelProviders, 'regex'] : ['noop', ...modelProviders, 'regex'];
  const printed: string[] = [];
  const diagnostics: string[] = [];
  const result = await runEvaluation({
    corpusPath,
    providerNames: providers,
    outDir,
    split: 'B',
    viewMode: 'g2-element',
    providerOptions: { answersFile: hostAnswersPath },
    stdout: (text) => { printed.push(text); },
    stderr: (text) => { diagnostics.push(text); },
  });
  const summary: G3Summary = {
    generated_at: new Date().toISOString(),
    corpus_path: corpusPath,
    split: 'B',
    view_mode: 'g2-element',
    host_answers_path: hostAnswersPath ?? null,
    providers: providers.map((provider) => summarize(provider, result.reports[provider], readBaseline(provider))),
    notes: [
      'Provider input uses G2 view-mode transformation after split filtering and before label/truth_hint stripping.',
      hostAnswersPath ? 'Host-file column used the supplied answers file.' : 'Host-file column was not run because no --host-answers or HOST_DECISION_ANSWERS path was supplied.',
      result.reports.typesafe?.skipped === 'no key' ? 'Jev column is skipped because TYPESAFE_API_KEY is absent.' : 'Jev column attempted the configured TypeSafe provider.',
      result.reports['laya-local']?.skipped ? `Laya local column skipped: ${result.reports['laya-local'].skipped}.` : 'Laya local column is included only when LAYA_LOCAL_ENABLED=1 is set.',
      'This table is G3 evidence only; thresholds still need to be frozen from A before a go/no-go decision.',
    ],
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'b-view-eval-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDir, 'b-view-eval-summary.md'), markdown(summary), 'utf8');
  fs.writeFileSync(path.join(outDir, 'b-view-eval-output.md'), printed.join(''), 'utf8');
  fs.writeFileSync(path.join(outDir, 'b-view-eval-diagnostics.log'), diagnostics.join(''), 'utf8');
  console.log(JSON.stringify({
    output: path.join(outDir, 'b-view-eval-summary.json'),
    providers: summary.providers.map((provider) => ({
      role: provider.role,
      provider: provider.provider,
      evaluated: provider.evaluated,
      accuracy: provider.accuracy,
      skipped: provider.skipped,
    })),
  }, null, 2));
  process.exitCode = result.exitCode;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 2;
});
