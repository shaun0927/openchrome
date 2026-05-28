/**
 * Tests for the OM2W runner shell (#1427 Part 2).
 *
 * Drives the runner with deterministic fakes — no real LLM, no real
 * browser. Validates step budget, early-stop, judge wiring.
 */
import {
  runOnlineMind2WebTask,
  fakeSentinelJudge,
  type RunnerStep,
  type RunnerDeps,
} from './runner';
import type { OnlineMind2WebTask } from './loader';

function fakeTask(): OnlineMind2WebTask {
  return {
    task_id: 'om2w-fake-1',
    website: 'https://example.com',
    task_description: 'find the login link',
    reference_length: 3,
  };
}

function fakeStep(i: number, summary: string, ok = true): RunnerStep {
  return { step: i, tool: 'navigate', args: { url: '/x' }, ok, summary };
}

describe('runOnlineMind2WebTask', () => {
  it('respects the 100-step default budget when no step ever fails or completes', async () => {
    const deps: RunnerDeps = {
      step: async (_t, i) => fakeStep(i, 'still searching'),
      judge: fakeSentinelJudge(),
    };
    const r = await runOnlineMind2WebTask(fakeTask(), deps);
    expect(r.steps_used).toBe(100);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('sentinel not reached');
    expect(r.judge_id).toBe('fake-sentinel');
  });

  it('passes when the fake judge sentinel is reached', async () => {
    const deps: RunnerDeps = {
      step: async (_t, i) => fakeStep(i, i === 5 ? 'navigate ok OM2W_COMPLETE' : 'navigate'),
      judge: fakeSentinelJudge(),
    };
    const r = await runOnlineMind2WebTask(fakeTask(), deps, { step_budget: 20 });
    expect(r.passed).toBe(true);
    expect(r.steps_used).toBe(20); // sentinel doesn't short-circuit; judge runs at end
  });

  it('stops early on the first hard step failure', async () => {
    const deps: RunnerDeps = {
      step: async (_t, i) => fakeStep(i, 'step ok', i !== 3),
      judge: fakeSentinelJudge(),
    };
    const r = await runOnlineMind2WebTask(fakeTask(), deps, { step_budget: 50 });
    expect(r.steps_used).toBe(3);
    expect(r.passed).toBe(false);
  });

  it('honours an explicit step_budget', async () => {
    const deps: RunnerDeps = {
      step: async (_t, i) => fakeStep(i, 'navigate'),
      judge: fakeSentinelJudge(),
    };
    const r = await runOnlineMind2WebTask(fakeTask(), deps, { step_budget: 7 });
    expect(r.steps_used).toBe(7);
  });

  it('respects an external shouldStop signal', async () => {
    const deps: RunnerDeps = {
      step: async (_t, i) => fakeStep(i, 'navigate'),
      shouldStop: (history) => history.length >= 4,
      judge: fakeSentinelJudge(),
    };
    const r = await runOnlineMind2WebTask(fakeTask(), deps, { step_budget: 50 });
    expect(r.steps_used).toBe(4);
  });

  it('forwards the judge_id through the result', async () => {
    const deps: RunnerDeps = {
      step: async (_t, i) => fakeStep(i, 'navigate'),
      judge: async () => ({ passed: true, reason: 'custom', judge_id: 'gpt-5.4' }),
    };
    const r = await runOnlineMind2WebTask(fakeTask(), deps, { step_budget: 3 });
    expect(r.judge_id).toBe('gpt-5.4');
    expect(r.passed).toBe(true);
    expect(r.reason).toBe('custom');
  });
});
