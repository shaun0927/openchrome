import { buildBenchmarkReadinessReport, OPEN_BENCHMARK_ISSUES, renderBenchmarkReadinessMarkdown } from './benchmark-readiness';

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
      1305,
      1310,
    ]);
  });

  it('states that the open benchmark suite is not fully measurable yet', () => {
    const report = buildBenchmarkReadinessReport(new Date('2026-05-16T00:00:00.000Z'));
    expect(report.summary.totalOpenBenchmarkIssues).toBe(16);
    expect(report.summary.ready).toBe(0);
    expect(report.summary.partial).toBe(11);
    expect(report.summary.notReady).toBe(5);
    expect(report.summary.headlineReady).toBe(0);
    expect(report.summary.diagnosticOrSmokeOnly).toBe(11);
    expect(report.summary.notMeasurable).toBe(5);
    expect(report.summary.canMeasureEveryOpenBenchmarkIssue).toBe(false);
  });

  it('calls out the real-world task completion runner as scaffold-only', () => {
    const report = buildBenchmarkReadinessReport(new Date('2026-05-16T00:00:00.000Z'));
    const realworld = report.issues.find((issue) => issue.issue === 1305);
    expect(realworld?.status).toBe('partial');
    expect(realworld?.measurementReadiness).toBe('diagnostic_or_smoke_only');
    expect(realworld?.evidence.join('\n')).toMatch(/bench:realworld/);
    expect(realworld?.blockers.join('\n')).toMatch(/deterministic scaffold/);
  });

  it('renders a human-readable not-ready verdict', () => {
    const report = buildBenchmarkReadinessReport(new Date('2026-05-16T00:00:00.000Z'));
    const markdown = renderBenchmarkReadinessMarkdown(report);
    expect(markdown).toContain('**NOT READY:**');
    expect(markdown).toContain('Issue matrix');
    expect(markdown).toContain('#1305');
  });
});
