/// <reference types="jest" />
import { runLiveRealWorldEpisodes, assertLiveRealWorldEnabled } from './live-runner';

describe('live real-world episode runner', () => {
  test('runs library × task × repetition through injected executor', async () => {
    const executor = { run: jest.fn(async () => ({ success: true, firstAttempt: true, recovered: null, wallTimeMs: 10, toolCalls: 1, retries: 0, noProgressLoops: 0, tokens: 5, usd: 0.001, failureCategory: 'none' as const, notes: 'dry-run final postcondition evaluated' })) };
    const result = await runLiveRealWorldEpisodes({ provider: 'openai', library: 'openchrome', repetitions: 2, taskIds: ['rw-001-checkout-update-address'], mode: 'dry-run' }, executor);
    expect(result.runs).toHaveLength(2);
    expect(executor.run).toHaveBeenCalledTimes(2);
    expect(result.claimEligibility.eligible).toBe(false);
    expect(result.claimEligibility.reasons.join('\n')).toMatch(/dry-run/);
  });
  test('live mode fails closed without explicit env', () => {
    expect(() => assertLiveRealWorldEnabled({} as NodeJS.ProcessEnv)).toThrow(/OPENCHROME_BENCH_REAL/);
  });
});
