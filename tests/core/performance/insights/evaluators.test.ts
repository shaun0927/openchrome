/// <reference types="jest" />

/**
 * Tests for the v1 performance-insights evaluators (#846).
 *
 * Each test exercises one evaluator against a synthetic trace fixture.
 * The fixtures are intentionally minimal so the test stays focused on
 * the evaluator's branch logic (severity tiers, no-data fallback,
 * ordering of contributors) rather than the trace event format itself.
 */

import {
  INSIGHT_NAMES,
  buildSummaryMarkdown,
  evaluateInsights,
  isInsightName,
} from '../../../../src/core/performance/insights';
import {
  emptyTrace,
  fastTrace,
  richTrace,
} from '../fixtures/sample-trace';

describe('evaluateInsights — closed-set surface', () => {
  test('always returns one summary per closed-set insight', () => {
    const { summaries, details } = evaluateInsights(emptyTrace());
    expect(summaries.map((s) => s.name).sort()).toEqual([...INSIGHT_NAMES].sort());
    for (const n of INSIGHT_NAMES) {
      expect(details[n]).toBeDefined();
      expect(details[n].insight).toBe(n);
    }
  });

  test('empty trace yields info / no data for every insight', () => {
    const { summaries } = evaluateInsights(emptyTrace());
    for (const s of summaries) {
      expect(s.severity).toBe('info');
    }
  });
});

describe('LCPBreakdown', () => {
  test('uses the last LCP candidate as the winner', () => {
    const { summaries, details } = evaluateInsights(richTrace());
    const lcp = summaries.find((s) => s.name === 'LCPBreakdown')!;
    expect(lcp.severity).toBe('warn');
    expect(lcp.one_line).toMatch(/3\.20s/);
    expect(details.LCPBreakdown.details_md).toMatch(/hero\.jpg/);
    expect(details.LCPBreakdown.evidence.some((e) => e.kind === 'metric')).toBe(true);
  });

  test('fast trace yields info severity', () => {
    const { summaries } = evaluateInsights(fastTrace());
    const lcp = summaries.find((s) => s.name === 'LCPBreakdown')!;
    expect(lcp.severity).toBe('info');
  });
});

describe('DocumentLatency', () => {
  test('computes TTFB from doc send/receive pair', () => {
    const { summaries, details } = evaluateInsights(richTrace());
    const dl = summaries.find((s) => s.name === 'DocumentLatency')!;
    expect(dl.severity).toBe('warn');
    expect(dl.one_line).toMatch(/example\.com/);
    expect(details.DocumentLatency.details_md).toMatch(/TTFB/);
  });

  test('fast trace yields info severity', () => {
    const { summaries } = evaluateInsights(fastTrace());
    const dl = summaries.find((s) => s.name === 'DocumentLatency')!;
    expect(dl.severity).toBe('info');
  });
});

describe('RenderBlocking', () => {
  test('counts render-blocking resources', () => {
    const { summaries, details } = evaluateInsights(richTrace());
    const rb = summaries.find((s) => s.name === 'RenderBlocking')!;
    expect(rb.one_line).toMatch(/1 render-blocking/);
    // URL with credential param should be redacted in details_md.
    expect(details.RenderBlocking.details_md).not.toMatch(/secretvalue/);
    expect(details.RenderBlocking.details_md).toMatch(/\[REDACTED\]/);
  });

  test('reports zero blocking when none present', () => {
    const { summaries } = evaluateInsights(fastTrace());
    const rb = summaries.find((s) => s.name === 'RenderBlocking')!;
    expect(rb.severity).toBe('info');
    expect(rb.one_line).toMatch(/no render-blocking/);
  });
});

describe('CLSCulprits', () => {
  test('sums layout shifts and ranks contributors', () => {
    const { summaries, details } = evaluateInsights(richTrace());
    const cls = summaries.find((s) => s.name === 'CLSCulprits')!;
    expect(cls.severity).toBe('warn');
    expect(cls.one_line).toMatch(/0\.170/);
    expect(details.CLSCulprits.details_md).toMatch(/Top contributors/);
  });

  test('returns no-data when no LayoutShift events present', () => {
    const { summaries } = evaluateInsights(fastTrace());
    const cls = summaries.find((s) => s.name === 'CLSCulprits')!;
    expect(cls.one_line).toBe('no data');
  });
});

describe('LongTasks', () => {
  test('flags tasks > 50ms and computes blocking time', () => {
    const { summaries, details } = evaluateInsights(richTrace());
    const lt = summaries.find((s) => s.name === 'LongTasks')!;
    // 250ms task: blocking = 200ms; 60ms task: blocking = 10ms => 210ms total
    expect(lt.severity).toBe('warn');
    expect(lt.one_line).toMatch(/2 long tasks/);
    expect(details.LongTasks.details_md).toMatch(/Top tasks/);
  });
});

describe('ThirdParties', () => {
  test('detects third-party host vs first-party document host', () => {
    const { summaries, details } = evaluateInsights(richTrace());
    const tp = summaries.find((s) => s.name === 'ThirdParties')!;
    expect(tp.one_line).toMatch(/1 third-party origin/);
    expect(details.ThirdParties.details_md).toMatch(/cdn\.thirdparty\.example/);
  });
});

describe('isInsightName', () => {
  test('accepts every closed-set name', () => {
    for (const n of INSIGHT_NAMES) expect(isInsightName(n)).toBe(true);
  });
  test('rejects unknown names', () => {
    expect(isInsightName('NotARealInsight')).toBe(false);
    expect(isInsightName('')).toBe(false);
    expect(isInsightName('lcpbreakdown')).toBe(false); // case-sensitive
  });
});

describe('buildSummaryMarkdown', () => {
  test('renders one bullet per insight with severity tag', () => {
    const { summaries } = evaluateInsights(richTrace());
    const md = buildSummaryMarkdown(summaries);
    expect(md.startsWith('# Performance insights')).toBe(true);
    for (const s of summaries) {
      expect(md).toContain(`**${s.name}** [${s.severity}]`);
    }
  });
});
