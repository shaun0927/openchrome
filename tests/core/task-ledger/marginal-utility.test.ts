/**
 * Tests for the marginal-utility tracker (issue #1428, Part 1).
 */
import {
  initialMarginalUtilityState,
  recordStep,
  summary,
  type StepSignals,
} from '../../../src/core/task-ledger/marginal-utility';

function signals(overrides: Partial<StepSignals> = {}): StepSignals {
  return {
    ts: 0,
    toolOk: true,
    assertPasses: 0,
    assertFails: 0,
    assertInconclusives: 0,
    checkpointAdvanced: false,
    ...overrides,
  };
}

describe('marginal-utility tracker', () => {
  it('starts with a neutral 0.5 prior and empty window', () => {
    const state = initialMarginalUtilityState();
    expect(state.totalSteps).toBe(0);
    expect(state.window).toHaveLength(0);
    expect(state.lastP).toBe(0.5);
  });

  it('monotonically increases p_success on a clean pass run', () => {
    let state = initialMarginalUtilityState();
    for (let i = 0; i < 5; i++) {
      state = recordStep(
        state,
        signals({ ts: i, assertPasses: 1, checkpointAdvanced: true }),
      );
    }
    expect(state.totalSteps).toBe(5);
    expect(state.lastP).toBeGreaterThan(0.5);
    // delta is positive on each step
    state.window.forEach((r) => expect(r.delta).toBeGreaterThanOrEqual(0));
  });

  it('drops p_success on a failure cluster', () => {
    let state = initialMarginalUtilityState();
    // Three passes establish a high prior.
    for (let i = 0; i < 3; i++) {
      state = recordStep(state, signals({ ts: i, assertPasses: 1 }));
    }
    const priorP = state.lastP;

    // Three failures must pull p_success down.
    for (let i = 3; i < 6; i++) {
      state = recordStep(
        state,
        signals({ ts: i, assertFails: 1, toolOk: false }),
      );
    }
    expect(state.lastP).toBeLessThan(priorP);
    // The last step's delta is negative.
    expect(state.window[state.window.length - 1].delta).toBeLessThan(0);
  });

  it('counts consecutive low-delta steps as a plateau', () => {
    // No asserts, tool ok every step → step_score = 0.7 each step.
    // After enough steps p_success stabilises near 0.7 with tiny deltas.
    let state = initialMarginalUtilityState();
    for (let i = 0; i < 25; i++) {
      state = recordStep(state, signals({ ts: i }));
    }
    const s = summary(state);
    expect(s.consecutive_low_delta).toBeGreaterThan(0);
  });

  it('is a pure function — identical inputs give identical outputs', () => {
    const input = signals({ ts: 7, assertPasses: 1 });
    const a = recordStep(initialMarginalUtilityState(), input);
    const b = recordStep(initialMarginalUtilityState(), input);
    expect(a).toEqual(b);
  });

  it('keeps the window bounded to WINDOW_SIZE entries', () => {
    let state = initialMarginalUtilityState();
    for (let i = 0; i < 50; i++) {
      state = recordStep(state, signals({ ts: i, assertPasses: 1 }));
    }
    expect(state.totalSteps).toBe(50);
    expect(state.window.length).toBeLessThanOrEqual(20);
  });

  it('summary on an empty state returns zeroed metrics', () => {
    const s = summary(initialMarginalUtilityState());
    expect(s.last_p).toBe(0.5);
    expect(s.mean_delta_per_step).toBe(0);
    expect(s.consecutive_low_delta).toBe(0);
  });
});
