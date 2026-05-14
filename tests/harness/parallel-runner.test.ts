/// <reference types="jest" />

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HarnessParallelRunner, HarnessScenario, sleep } from './parallel-runner';

describe('HarnessParallelRunner', () => {
  test('enforces concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const scenarios: HarnessScenario<number>[] = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active--;
        return i;
      },
    }));

    const runner = new HarnessParallelRunner<number>({
      concurrency: 2,
      scenarioTimeoutMs: 500,
      maxErrors: 10,
      stragglerAfterMs: 250,
    });

    const result = await runner.run(scenarios);

    expect(result.completed).toHaveLength(6);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(result.failed).toHaveLength(0);
    expect(result.timedOut).toHaveLength(0);
  });

  test('records stragglers separately from timed out scenarios', async () => {
    const runner = new HarnessParallelRunner<string>({
      concurrency: 1,
      scenarioTimeoutMs: 500,
      maxErrors: 5,
      stragglerAfterMs: 20,
    });

    const result = await runner.run([{ id: 'slow-ok', run: async () => { await sleep(60); return 'ok'; } }]);

    expect(result.completed).toHaveLength(1);
    expect(result.timedOut).toHaveLength(0);
    expect(result.stragglers.map((s) => s.id)).toContain('slow-ok');
  });

  test('times out scenarios and invokes cleanup', async () => {
    let cleaned = false;
    const runner = new HarnessParallelRunner<string>({
      concurrency: 1,
      scenarioTimeoutMs: 20,
      maxErrors: 5,
      stragglerAfterMs: 5,
    });

    const result = await runner.run([{ id: 'timeout', run: async (signal) => { await sleep(1_000, signal); return 'late'; }, cleanup: () => { cleaned = true; } }]);

    expect(result.completed).toHaveLength(0);
    expect(result.timedOut.map((t) => t.id)).toContain('timeout');
    expect(cleaned).toBe(true);
  });

  test('cancels queued scenarios after maxErrors while preserving partial evidence', async () => {
    const runner = new HarnessParallelRunner<string>({
      concurrency: 1,
      scenarioTimeoutMs: 200,
      maxErrors: 1,
      stragglerAfterMs: 100,
    });

    const result = await runner.run([
      { id: 'ok', run: async () => 'done' },
      { id: 'fail', run: async () => { throw new Error('boom'); } },
      { id: 'queued', run: async () => 'not-run' },
    ]);

    expect(result.completed.map((r) => r.id)).toContain('ok');
    expect(result.failed.map((r) => r.id)).toContain('fail');
    expect(result.cancelled).toBe(true);
    expect(result.results.find((r) => r.id === 'queued')?.status).toBe('cancelled');
  });


  test('aborts active scenarios when maxErrors is reached', async () => {
    let slowCleaned = false;
    const runner = new HarnessParallelRunner<string>({
      concurrency: 2,
      scenarioTimeoutMs: 1_000,
      maxErrors: 1,
      stragglerAfterMs: 500,
    });

    const result = await runner.run([
      { id: 'fail-fast', run: async () => { throw new Error('boom'); } },
      { id: 'slow-active', run: async (signal) => { await sleep(1_000, signal); return 'late'; }, cleanup: () => { slowCleaned = true; } },
      { id: 'queued', run: async () => 'not-run' },
    ]);

    expect(result.cancelled).toBe(true);
    expect(result.failed.map((r) => r.id)).toContain('fail-fast');
    expect(result.results.find((r) => r.id === 'slow-active')?.status).toBe('cancelled');
    expect(result.results.find((r) => r.id === 'queued')?.status).toBe('cancelled');
    expect(slowCleaned).toBe(true);
  });

  test('writes partial result JSON', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-harness-'));
    const output = path.join(dir, 'partial.json');
    const runner = new HarnessParallelRunner<string>({
      concurrency: 1,
      scenarioTimeoutMs: 200,
      maxErrors: 5,
      stragglerAfterMs: 100,
      partialWritePath: output,
    });

    await runner.run([{ id: 'ok', run: async () => 'done' }]);
    const parsed = JSON.parse(await fs.readFile(output, 'utf8'));

    expect(parsed.parallel.completed).toHaveLength(1);
    expect(parsed.parallel.results[0].id).toBe('ok');
  });
});
