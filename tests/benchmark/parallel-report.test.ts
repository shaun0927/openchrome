/// <reference types="jest" />

import {
  buildComparisons,
  buildScalabilityCurve,
  formatComparisonTable,
  formatScalabilityCurve,
  formatParallelReport,
  toJSON,
  ParallelComparisonEntry,
} from './parallel-report';
import { BenchmarkReport } from './benchmark-runner';

function makeReport(
  adapter: string,
  mode: string,
  tasks: Array<{ name: string; meanWallTimeMs: number; meanToolCalls: number }>
): BenchmarkReport {
  return {
    adapter,
    mode,
    tasks: tasks.map((t) => ({
      name: t.name,
      runs: [],
      stats: {
        meanInputChars: 100,
        meanOutputChars: 200,
        meanToolCalls: t.meanToolCalls,
        meanWallTimeMs: t.meanWallTimeMs,
        successRate: 1,
        ci95InputChars: [90, 110] as [number, number],
        ci95OutputChars: [180, 220] as [number, number],
      },
    })),
    summary: { totalInputChars: 300, totalOutputChars: 600, totalToolCalls: 10 },
  };
}

describe('buildComparisons', () => {
  test('matches sequential/parallel pairs by suffix', () => {
    const seq = makeReport('OC', 'seq', [
      { name: 'sequential-3x', meanWallTimeMs: 3000, meanToolCalls: 6 },
      { name: 'sequential-5x', meanWallTimeMs: 5000, meanToolCalls: 10 },
    ]);
    const par = makeReport('OC', 'par', [
      { name: 'parallel-3x', meanWallTimeMs: 1100, meanToolCalls: 8 },
      { name: 'parallel-5x', meanWallTimeMs: 1200, meanToolCalls: 12 },
    ]);

    const comparisons = buildComparisons(seq, par);

    expect(comparisons).toHaveLength(2);
    expect(comparisons[0].taskName).toBe('3x');
    expect(comparisons[0].concurrency).toBe(3);
    expect(comparisons[0].speedupFactor).toBeCloseTo(2.73, 1);
    expect(comparisons[1].taskName).toBe('5x');
    expect(comparisons[1].concurrency).toBe(5);
  });

  test('returns empty for unmatched pairs', () => {
    const seq = makeReport('OC', 'seq', [
      { name: 'sequential-3x', meanWallTimeMs: 3000, meanToolCalls: 6 },
    ]);
    const par = makeReport('OC', 'par', [
      { name: 'parallel-10x', meanWallTimeMs: 1000, meanToolCalls: 22 },
    ]);

    expect(buildComparisons(seq, par)).toHaveLength(0);
  });

  test('computes efficiency correctly', () => {
    const seq = makeReport('OC', 'seq', [
      { name: 'sequential-5x', meanWallTimeMs: 5000, meanToolCalls: 10 },
    ]);
    const par = makeReport('OC', 'par', [
      { name: 'parallel-5x', meanWallTimeMs: 1250, meanToolCalls: 12 },
    ]);

    const [c] = buildComparisons(seq, par);
    // speedup = 4.0, efficiency = 4.0/5 * 100 = 80%
    expect(c.speedupFactor).toBe(4);
    expect(c.efficiency).toBe(80);
  });
});

describe('buildScalabilityCurve', () => {
  test('sorts by concurrency', () => {
    const entries: ParallelComparisonEntry[] = [
      { taskName: '10x', concurrency: 10, seqWallTimeMs: 10000, parWallTimeMs: 2000, seqToolCalls: 20, parToolCalls: 22, speedupFactor: 5, efficiency: 50 },
      { taskName: '3x', concurrency: 3, seqWallTimeMs: 3000, parWallTimeMs: 1100, seqToolCalls: 6, parToolCalls: 8, speedupFactor: 2.73, efficiency: 91 },
      { taskName: '5x', concurrency: 5, seqWallTimeMs: 5000, parWallTimeMs: 1200, seqToolCalls: 10, parToolCalls: 12, speedupFactor: 4.17, efficiency: 83 },
    ];

    const curve = buildScalabilityCurve(entries);
    expect(curve.map((p) => p.n)).toEqual([3, 5, 10]);
  });
});

describe('formatComparisonTable', () => {
  test('produces table with correct columns', () => {
    const entries: ParallelComparisonEntry[] = [
      { taskName: '3x', concurrency: 3, seqWallTimeMs: 3000, parWallTimeMs: 1100, seqToolCalls: 6, parToolCalls: 8, speedupFactor: 2.73, efficiency: 91 },
    ];

    const table = formatComparisonTable('Test Category', entries);

    expect(table).toContain('Test Category');
    expect(table).toContain('Scale');
    expect(table).toContain('Seq Time');
    expect(table).toContain('Par Time');
    expect(table).toContain('Speedup');
    expect(table).toContain('Eff(%)');
    expect(table).toContain('3x');
    expect(table).toContain('2.73x');
    expect(table).toContain('91%');
  });

  test('returns empty string for empty comparisons', () => {
    expect(formatComparisonTable('Empty', [])).toBe('');
  });
});

describe('formatScalabilityCurve', () => {
  test('produces ASCII bar chart', () => {
    const curve = [
      { n: 3, seqWallTimeMs: 3000, parWallTimeMs: 1100, speedupFactor: 2.7, parallelEfficiency: 90 },
      { n: 5, seqWallTimeMs: 5000, parWallTimeMs: 1200, speedupFactor: 4.2, parallelEfficiency: 84 },
    ];

    const chart = formatScalabilityCurve(curve);

    expect(chart).toContain('Scalability Curve');
    expect(chart).toContain('N= 3');
    expect(chart).toContain('N= 5');
    expect(chart).toContain('█');
  });

  test('returns empty for empty curve', () => {
    expect(formatScalabilityCurve([])).toBe('');
  });
});

describe('formatParallelReport', () => {
  test('produces full report with categories', () => {
    const categories = [
      {
        title: 'Multi-Step',
        comparisons: [
          { taskName: '3x', concurrency: 3, seqWallTimeMs: 3000, parWallTimeMs: 1100, seqToolCalls: 27, parToolCalls: 29, speedupFactor: 2.73, efficiency: 91 },
        ],
      },
    ];

    const report = formatParallelReport(categories);

    expect(report).toContain('PARALLEL BENCHMARK RESULTS');
    expect(report).toContain('[1] Multi-Step');
    expect(report).toContain('Scalability Curve');
  });
});

describe('toJSON', () => {
  test('produces valid JSON with timestamp and categories', () => {
    const categories = [
      {
        title: 'Test',
        comparisons: [
          { taskName: '3x', concurrency: 3, seqWallTimeMs: 3000, parWallTimeMs: 1100, seqToolCalls: 6, parToolCalls: 8, speedupFactor: 2.73, efficiency: 91 },
        ],
      },
    ];

    const json = toJSON(categories);
    const parsed = JSON.parse(json);

    expect(parsed.timestamp).toBeDefined();
    expect(parsed.categories).toHaveLength(1);
    expect(parsed.categories[0].title).toBe('Test');
    expect(parsed.categories[0].scalabilityCurve).toBeDefined();
  });
});
