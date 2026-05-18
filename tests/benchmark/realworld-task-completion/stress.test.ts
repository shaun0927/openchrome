/// <reference types="jest" />

import { buildRealWorldTaskCompletionResult } from '../run-realworld-task-completion';
import { deterministicOpenChromeStressRuns, realWorldTaskSpecs } from './fixtures';

describe('real-world task fault stress rows', () => {
  test('injects one deterministic fault per task and recovers only through final postconditions', () => {
    const runs = deterministicOpenChromeStressRuns();
    expect(runs).toHaveLength(realWorldTaskSpecs.length);
    expect(runs.every((run) => run.faultInjected === true)).toBe(true);
    expect(runs.every((run) => run.faultCheckpoint?.injected === true)).toBe(true);
    expect(runs.every((run) => run.recovered === (run.success && run.finalPostconditionEvaluated === true))).toBe(true);
    expect(runs.every((run) => typeof run.recoveryTimeMs === 'number' && run.recoveryTimeMs > 0)).toBe(true);
    expect(runs.every((run) => run.zombieProcessCount === 0)).toBe(true);
  });

  test('stress result stays diagnostic and exposes fault rows separately', () => {
    const envelope = buildRealWorldTaskCompletionResult(['--stress']);
    const result = envelope.results[0];
    expect(result.stressMode).toBe(true);
    expect(result.claimEligibility.eligible).toBe(false);
    expect(result.faultRows).toHaveLength(realWorldTaskSpecs.length);
    expect(result.faultRows.every((run) => run.recovered === true && run.finalPostconditionEvaluated === true)).toBe(true);
  });
});
