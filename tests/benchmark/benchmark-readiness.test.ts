import {
  ADDITIONAL_BENCHMARK_PR_SCOPES,
  buildBenchmarkReadinessReport,
  OPEN_BENCHMARK_ISSUES,
  renderBenchmarkReadinessMarkdown,
} from './benchmark-readiness';

describe('benchmark readiness audit', () => {
  it('covers every currently open benchmark issue tracked by the audit', () => {
    const issueNumbers = OPEN_BENCHMARK_ISSUES.map((issue) => issue.issue).sort((a, b) => a - b);
    expect(issueNumbers).toEqual([
      1254,
      1255,
      1256,
      1257,
      1258,
      1259,
      1260,
      1261,
      1299,
      1300,
      1301,
      1302,
      1303,
      1304,
      1310,
    ]);
  });

  it('states that the open benchmark suite is not fully measurable or api-key-only ready yet', () => {
    const report = buildBenchmarkReadinessReport(new Date('2026-05-17T00:00:00.000Z'));
    expect(report.summary.totalOpenBenchmarkIssues).toBe(15);
    expect(report.summary.ready).toBe(0);
    expect(report.summary.partial).toBe(13);
    expect(report.summary.notReady).toBe(2);
    expect(report.summary.headlineReady).toBe(0);
    expect(report.summary.diagnosticOrSmokeOnly).toBe(13);
    expect(report.summary.notMeasurable).toBe(2);
    expect(report.summary.canMeasureEveryOpenBenchmarkIssue).toBe(false);
    expect(report.summary.apiKeyOnlyReady).toBe(0);
    expect(report.summary.nonKeyBlocked).toBe(15);
    expect(report.summary.apiKeyOnlyCanMeasureEveryOpenBenchmarkIssue).toBe(false);
    expect(report.summary.staleResultArtifactCount).toBeGreaterThan(0);
    expect(report.artifactFreshness.currentOpenChromeVersion).toBe('1.12.4');
  });

  it('keeps the closed #1305 real-world task runner out of the open-issue audit', () => {
    const report = buildBenchmarkReadinessReport(new Date('2026-05-17T00:00:00.000Z'));
    expect(report.issues.find((issue) => issue.issue === 1305)).toBeUndefined();
    const headlineGate = report.issues.find((issue) => issue.issue === 1310);
    expect(headlineGate?.status).toBe('partial');
    expect(headlineGate?.measurementReadiness).toBe('diagnostic_or_smoke_only');
    expect(headlineGate?.nonKeyBlockers?.join('\n')).toMatch(/live or recorded-real evidence/);
  });

  it('records the additional PR ladder needed before API keys are the only remaining gate', () => {
    expect(ADDITIONAL_BENCHMARK_PR_SCOPES.map((scope) => scope.id)).toEqual([
      'PR1',
      'PR2',
      'PR3',
      'PR4',
      'PR5',
      'PR6',
      'PR7',
      'PR8',
    ]);
    const coveredIssues = new Set(ADDITIONAL_BENCHMARK_PR_SCOPES.flatMap((scope) => scope.issues));
    for (const issue of OPEN_BENCHMARK_ISSUES) expect(coveredIssues.has(issue.issue)).toBe(true);
    expect(ADDITIONAL_BENCHMARK_PR_SCOPES[0].inScope).toContain('claimEligibility validation for rows and aggregates');
    expect(ADDITIONAL_BENCHMARK_PR_SCOPES[0].outOfScope).toContain('OpenChrome product/core changes');
  });

  it('renders a human-readable not-ready verdict and API-key-only PR scopes', () => {
    const report = buildBenchmarkReadinessReport(new Date('2026-05-17T00:00:00.000Z'));
    const markdown = renderBenchmarkReadinessMarkdown(report);
    expect(markdown).toContain('**NOT READY:**');
    expect(markdown).toContain('API-key-only readiness');
    expect(markdown).toContain('Additional PR scopes to reach API-key-only readiness');
    expect(markdown).toContain('Result artifact freshness');
    expect(markdown).toContain('Stale OpenChrome result artifacts');
    expect(markdown).toContain('PR1: Benchmark contract hardening');
    expect(markdown).toContain('Out of scope:');
    expect(markdown).toContain('OpenChrome product/core changes');
    expect(markdown).not.toContain('#1305');
  });
});
