/// <reference types="jest" />

import { buildFullBenchmarkPreflight, parseFullBenchmarkArgs } from './run-full-benchmark';

describe('full benchmark orchestration', () => {
  test('parses live preflight with repetition cost input', () => {
    const opts = parseFullBenchmarkArgs(['--mode', 'live', '--preflight', '--repetitions', '5']);
    expect(opts).toEqual({ mode: 'live', preflight: true, execute: false, repetitions: 5 });
  });

  test('preflight reports only runtime/secrets blockers plus ordered axes', async () => {
    const result = await buildFullBenchmarkPreflight(['--mode', 'live', '--preflight', '--repetitions', '2']);
    expect(result.mode).toBe('live');
    expect(result.costEstimate.worstCaseUsd).toBe(61 * 3 * 2 * 0.5);
    expect(result.orderedAxes[0]).toBe('runtime-preflight');
    expect(result.orderedAxes).toContain('unified-report');
    expect(result.missing.every((item) => /: /.test(item))).toBe(true);
  });
});
