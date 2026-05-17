/// <reference types="jest" />

import { runAuthBenchmark, runAuthBenchmarkWithLocalSmoke } from './run-auth';

describe('auth usability benchmark', () => {
  test('default rows keep live smoke explicit as not-run', () => {
    const rows = runAuthBenchmark();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.localFixtureSmoke === 'not-run')).toBe(true);
    expect(rows.every((row) => row.wallClockMinutes === null)).toBe(true);
  });

  test('local smoke logs into the reproducible auth fixture and records setup wall-clock', async () => {
    const rows = await runAuthBenchmarkWithLocalSmoke();
    expect(rows.every((row) => row.localFixtureSmoke === 'passed')).toBe(true);
    expect(rows.every((row) => row.loggedInSmoked)).toBe(true);
    expect(rows.every((row) => typeof row.wallClockMinutes === 'number')).toBe(true);
  });
});
