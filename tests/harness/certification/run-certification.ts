import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runCertificationScenarios } from './scenarios';
import type { HarnessCertificationReport, HarnessCertificationThresholds } from './types';

const DEFAULT_OUT = 'artifacts/harness-certification';
const THRESHOLDS_PATH = path.join(__dirname, '..', 'harness-certification.thresholds.json');

export async function loadThresholds(filePath = THRESHOLDS_PATH): Promise<HarnessCertificationThresholds> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as HarnessCertificationThresholds;
}

export function buildReport(thresholds: HarnessCertificationThresholds, now = new Date()): HarnessCertificationReport {
  const started = now;
  const scenarios = runCertificationScenarios(thresholds);
  const totalDurationMs = scenarios.reduce((sum, scenario) => sum + scenario.durationMs, 0);
  const ended = new Date(started.getTime() + totalDurationMs);
  return {
    version: 1,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    server: {
      command: 'node dist/cli/index.js serve --http <port> --server-mode',
      port: 0,
      mode: 'deterministic-local-fixture',
    },
    summary: {
      totalScenarios: scenarios.length,
      passedScenarios: scenarios.filter((scenario) => scenario.success).length,
      failedScenarios: scenarios.filter((scenario) => !scenario.success).length,
      totalDurationMs,
      configuredGlobalTimeoutMs: thresholds.globalTimeoutMs,
    },
    scenarios,
    thresholds,
  };
}

export async function writeReport(report: HarnessCertificationReport, outDir = DEFAULT_OUT): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'latest.txt'), renderText(report));
}

export function assertReportPasses(report: HarnessCertificationReport): void {
  const failures = report.scenarios.filter((scenario) => !scenario.success);
  if (failures.length > 0) {
    throw new Error(`certification failed: ${failures.map((f) => `${f.scenario}: ${f.failureReason}`).join('; ')}`);
  }
  if (report.summary.totalDurationMs >= report.summary.configuredGlobalTimeoutMs) {
    throw new Error(`certification exceeded global timeout: ${report.summary.totalDurationMs} >= ${report.summary.configuredGlobalTimeoutMs}`);
  }
}

function renderText(report: HarnessCertificationReport): string {
  const lines = [
    'OpenChrome harness certification report',
    `Started: ${report.startedAt}`,
    `Scenarios: ${report.summary.passedScenarios}/${report.summary.totalScenarios} passed`,
    `Total duration: ${report.summary.totalDurationMs}ms / ${report.summary.configuredGlobalTimeoutMs}ms`,
    '',
  ];
  for (const scenario of report.scenarios) {
    lines.push(`- ${scenario.scenario}: ${scenario.success ? 'PASS' : 'FAIL'}; tools=${scenario.toolCalls}; nonProgress=${scenario.nonProgressCalls}; stuck=${scenario.stuckEvents}; p99=${scenario.p99ToolLatencyMs ?? 0}ms${scenario.failureReason ? `; reason=${scenario.failureReason}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--output');
  const outDir = outIndex >= 0 && process.argv[outIndex + 1] ? process.argv[outIndex + 1] : DEFAULT_OUT;
  const thresholds = await loadThresholds();
  const report = buildReport(thresholds, process.argv.includes('--ci') ? new Date('2026-05-13T00:00:00.000Z') : new Date());
  await writeReport(report, outDir);
  assertReportPasses(report);
  console.log(JSON.stringify({ output: path.join(outDir, 'latest.json'), scenarios: report.summary.totalScenarios, passed: report.summary.passedScenarios, durationMs: report.summary.totalDurationMs }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
