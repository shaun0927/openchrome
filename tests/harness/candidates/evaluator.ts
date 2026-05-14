import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CANDIDATES, SCENARIOS } from './fixtures';
import type { CandidateReport, CandidateScore, HarnessCandidate, HarnessScenario } from './types';

const DEFAULT_OUT = 'artifacts/harness-candidates';

export function scoreCandidate(candidate: HarnessCandidate, scenario: HarnessScenario): CandidateScore {
  const applies = candidate.policy.expectedFamilies.includes(scenario.failureFamily);
  const toolTrace = candidate.policy.toolSequence.map((tool) => ({ tool, ok: applies }));
  const safetyViolations = countSafetyViolations(candidate, scenario);
  const missingTools = scenario.expectedTools.filter((tool) => !candidate.policy.toolSequence.includes(tool));
  const extraNonProgress = applies ? 0 : scenario.baselineNonProgressCalls;
  const recoveryTimeMs = applies
    ? scenario.expectedRecoveryTimeMs + candidate.policy.toolSequence.length * 50
    : scenario.expectedRecoveryTimeMs + 1_000;

  let score = 0;
  if (applies) score += 70;
  score += Math.max(0, 20 - missingTools.length * 10);
  score += Math.max(0, 10 - extraNonProgress * 3);
  score -= safetyViolations * 100;
  if (!candidate.safety.productionEligible) score -= 50;
  score = Math.max(0, Math.min(100, score));

  const success = applies && missingTools.length === 0 && safetyViolations === 0 && candidate.safety.productionEligible;
  const failureReason = success
    ? undefined
    : [
        !applies ? `candidate does not apply to ${scenario.failureFamily}` : undefined,
        missingTools.length > 0 ? `missing expected tools: ${missingTools.join(', ')}` : undefined,
        safetyViolations > 0 ? 'safety violation' : undefined,
        !candidate.safety.productionEligible ? `not production eligible: ${candidate.safety.reason}` : undefined,
      ].filter(Boolean).join('; ');

  return {
    candidateId: candidate.id,
    scenario: scenario.id,
    success,
    score,
    toolCalls: candidate.policy.toolSequence.length,
    nonProgressCalls: extraNonProgress,
    recoveryTimeMs,
    safetyViolations,
    ...(failureReason ? { failureReason } : {}),
    toolTrace,
  };
}

export function buildReport(now = new Date('2026-05-13T00:00:00.000Z')): CandidateReport {
  const scores = CANDIDATES.flatMap((candidate) => SCENARIOS.map((scenario) => scoreCandidate(candidate, scenario)));
  const rejected = CANDIDATES
    .filter((candidate) => !candidate.safety.productionEligible || scores.some((s) => s.candidateId === candidate.id && s.safetyViolations > 0))
    .map((candidate) => ({ candidateId: candidate.id, reason: candidate.safety.productionEligible ? 'safety violation in scenario' : candidate.safety.reason }));
  const rejectedIds = new Set(rejected.map((r) => r.candidateId));
  const averages = averageScores(scores);
  const bestPerFailureFamily: CandidateReport['bestPerFailureFamily'] = {};

  for (const scenario of SCENARIOS) {
    const familyScores = scores
      .filter((score) => score.scenario === scenario.id && !rejectedIds.has(score.candidateId))
      .sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));
    if (familyScores[0]) {
      bestPerFailureFamily[scenario.failureFamily] = { candidateId: familyScores[0].candidateId, score: familyScores[0].score };
    }
  }

  const bestOverallEntry = Object.entries(averages)
    .filter(([candidateId]) => !rejectedIds.has(candidateId))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  const recommended = CANDIDATES
    .filter((candidate) => !rejectedIds.has(candidate.id))
    .map((candidate) => ({
      candidateId: candidate.id,
      reason: 'Best for at least one failure family and passed safety gates.',
      bestFor: Object.entries(bestPerFailureFamily).filter(([, best]) => best.candidateId === candidate.id).map(([family]) => family),
      averageScore: averages[candidate.id] ?? 0,
    }))
    .filter((entry) => entry.bestFor.length > 0)
    .sort((a, b) => b.averageScore - a.averageScore || a.candidateId.localeCompare(b.candidateId));

  return {
    version: 1,
    generatedAt: now.toISOString(),
    server: { command: 'node dist/cli/index.js serve --server-mode', mode: 'deterministic-local-fixture' },
    candidates: CANDIDATES,
    scenarios: SCENARIOS,
    scores,
    recommended,
    rejected,
    ...(bestOverallEntry ? { bestOverall: { candidateId: bestOverallEntry[0], averageScore: bestOverallEntry[1] } } : {}),
    bestPerFailureFamily,
  };
}

export async function writeReport(report: CandidateReport, outDir = DEFAULT_OUT): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'latest.md'), renderMarkdown(report));
}

function averageScores(scores: CandidateScore[]): Record<string, number> {
  const totals = new Map<string, { score: number; count: number }>();
  for (const score of scores) {
    const prev = totals.get(score.candidateId) ?? { score: 0, count: 0 };
    prev.score += score.score;
    prev.count += 1;
    totals.set(score.candidateId, prev);
  }
  return Object.fromEntries([...totals].map(([id, value]) => [id, Number((value.score / value.count).toFixed(2))]));
}

function countSafetyViolations(candidate: HarnessCandidate, scenario: HarnessScenario): number {
  const haystack = `${scenario.riskyText ?? ''} ${candidate.description} ${candidate.policy.toolSequence.join(' ')}`.toLowerCase();
  return (candidate.policy.avoidPatterns ?? []).some((pattern) => haystack.includes(pattern.toLowerCase())) ? 1 : 0;
}

function renderMarkdown(report: CandidateReport): string {
  const lines = ['# Harness candidate evaluation', '', `Generated: ${report.generatedAt}`, ''];
  lines.push('## Recommended', '');
  for (const rec of report.recommended) lines.push(`- **${rec.candidateId}** — ${rec.reason} Best for: ${rec.bestFor.join(', ')}.`);
  lines.push('', '## Rejected', '');
  for (const rej of report.rejected) lines.push(`- **${rej.candidateId}** — ${rej.reason}`);
  lines.push('', '## Scores', '', '| Candidate | Scenario | Success | Score | Safety violations |', '|---|---:|---:|---:|---:|');
  for (const score of report.scores) lines.push(`| ${score.candidateId} | ${score.scenario} | ${score.success} | ${score.score} | ${score.safetyViolations} |`);
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--output');
  const outDir = outIndex >= 0 && process.argv[outIndex + 1] ? process.argv[outIndex + 1] : DEFAULT_OUT;
  const report = buildReport(process.argv.includes('--ci') ? new Date('2026-05-13T00:00:00.000Z') : new Date());
  await writeReport(report, outDir);
  console.log(JSON.stringify({ output: path.join(outDir, 'latest.json'), candidates: report.candidates.length, scenarios: report.scenarios.length, recommended: report.recommended.length, rejected: report.rejected.length }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
