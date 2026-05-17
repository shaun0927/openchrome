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
  test('rejects unknown task ids instead of silently shrinking coverage', async () => {
    const executor = { run: jest.fn() };

    await expect(runLiveRealWorldEpisodes({ provider: 'openai', library: 'openchrome', repetitions: 1, taskIds: ['missing-task'], mode: 'dry-run' }, executor)).rejects.toThrow(/Unknown real-world taskIds: missing-task/);
    expect(executor.run).not.toHaveBeenCalled();
  });

  test('non-dry runs require explicit pinning evidence for headline eligibility', async () => {
    const executor = { run: jest.fn(async () => ({ success: true, firstAttempt: true, recovered: null, wallTimeMs: 10, toolCalls: 1, retries: 0, noProgressLoops: 0, tokens: 5, usd: 0.001, failureCategory: 'none' as const, notes: 'recorded postcondition', finalPostconditionEvaluated: true })) };
    const previous = process.env.OPENCHROME_BENCH_REAL;
    process.env.OPENCHROME_BENCH_REAL = '1';
    const result = await runLiveRealWorldEpisodes({ provider: 'openai', library: 'openchrome', repetitions: 10, taskIds: ['rw-001-checkout-update-address'], mode: 'recorded-real' }, executor);
    if (previous === undefined) delete process.env.OPENCHROME_BENCH_REAL;
    else process.env.OPENCHROME_BENCH_REAL = previous;

    expect(result.claimEligibility.eligible).toBe(false);
    expect(result.claimEligibility.reasons.join('\n')).toMatch(/versions are not pinned/);
    expect(result.claimEligibility.reasons.join('\n')).toMatch(/LLM model/);
  });

  test('postcondition eligibility is derived from executor evidence', async () => {
    const executor = { run: jest.fn(async () => ({ success: true, firstAttempt: true, recovered: null, wallTimeMs: 10, toolCalls: 1, retries: 0, noProgressLoops: 0, tokens: 5, usd: 0.001, failureCategory: 'none' as const, notes: 'recorded without postcondition evidence' })) };
    const previous = process.env.OPENCHROME_BENCH_REAL;
    process.env.OPENCHROME_BENCH_REAL = '1';
    const result = await runLiveRealWorldEpisodes({ provider: 'openai', library: 'openchrome', repetitions: 10, taskIds: ['rw-001-checkout-update-address'], mode: 'recorded-real', competitorVersionsPinned: true, llmSettingsPinned: true }, executor);
    if (previous === undefined) delete process.env.OPENCHROME_BENCH_REAL;
    else process.env.OPENCHROME_BENCH_REAL = previous;

    expect(result.claimEligibility.eligible).toBe(false);
    expect(result.claimEligibility.reasons.join('\n')).toMatch(/postcondition/);
  });

  test('recorded-real mode fails closed without explicit env', async () => {
    const executor = { run: jest.fn() };
    await expect(runLiveRealWorldEpisodes({ provider: 'openai', library: 'openchrome', repetitions: 1, taskIds: ['rw-001-checkout-update-address'], mode: 'recorded-real' }, executor)).rejects.toThrow(/OPENCHROME_BENCH_REAL/);
  });

  test('live mode fails closed without explicit env', () => {
    expect(() => assertLiveRealWorldEnabled({} as NodeJS.ProcessEnv)).toThrow(/OPENCHROME_BENCH_REAL/);
  });
});
