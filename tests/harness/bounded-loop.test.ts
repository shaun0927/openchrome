import { describe, expect, it } from '@jest/globals';
import { createBoundedLoop } from '../../src/harness/bounded-loop.js';

interface S { steps: number; answer?: string }

describe('createBoundedLoop', () => {
  it('returns done when isDone flips', async () => {
    const loop = createBoundedLoop<S>({
      maxSteps: 10,
      maxWallMs: 1_000,
      beastMode: async ({ state }) => ({ ...state, answer: 'forced' }),
    });
    const result = await loop.run({
      initialState: { steps: 0 },
      step: async ({ state }) => ({
        steps: state.steps + 1,
        answer: state.steps + 1 === 3 ? 'ok' : undefined,
      }),
      isDone: (s) => s.answer !== undefined,
    });
    expect(result.terminationReason).toBe('done');
    expect(result.answer.answer).toBe('ok');
    expect(result.stepsUsed).toBe(3);
  });

  it('invokes beast mode on step budget', async () => {
    const loop = createBoundedLoop<S>({
      maxSteps: 3,
      maxWallMs: 10_000,
      beastMode: async ({ state, reason }) => ({ ...state, answer: `hedged-${reason}` }),
    });
    const result = await loop.run({
      initialState: { steps: 0 },
      step: async ({ state }) => ({ steps: state.steps + 1 }),
      isDone: () => false,
    });
    expect(result.terminationReason).toBe('budget-steps');
    expect(result.answer.answer).toBe('hedged-budget-steps');
    expect(result.stepsUsed).toBe(3);
  });

  it('invokes beast mode on wall budget', async () => {
    let clock = 0;
    const loop = createBoundedLoop<S>({
      maxSteps: 1_000,
      maxWallMs: 100,
      now: () => clock,
      beastMode: async ({ state, reason }) => ({ ...state, answer: `hedged-${reason}` }),
    });
    const result = await loop.run({
      initialState: { steps: 0 },
      step: async ({ state }) => { clock += 50; return { steps: state.steps + 1 }; },
      isDone: () => false,
    });
    expect(result.terminationReason).toBe('budget-wall');
    expect(result.answer.answer).toBe('hedged-budget-wall');
  });

  it('returns error when step throws', async () => {
    const loop = createBoundedLoop<S>({
      maxSteps: 10,
      maxWallMs: 10_000,
      beastMode: async ({ state }) => ({ ...state, answer: 'never' }),
    });
    const result = await loop.run({
      initialState: { steps: 0 },
      step: async () => { throw new Error('boom'); },
      isDone: () => false,
    });
    expect(result.terminationReason).toBe('error');
    expect(result.errorMessage).toBe('boom');
  });

  it('returns error when beast mode throws too', async () => {
    const loop = createBoundedLoop<S>({
      maxSteps: 1,
      maxWallMs: 10_000,
      beastMode: async () => { throw new Error('beast-boom'); },
    });
    const result = await loop.run({
      initialState: { steps: 0 },
      step: async ({ state }) => ({ steps: state.steps + 1 }),
      isDone: () => false,
    });
    expect(result.terminationReason).toBe('error');
    expect(result.errorMessage).toBe('beast-boom');
  });
});
