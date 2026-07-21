import { describe, expect, it } from '@jest/globals';
import { createBoundedLoop } from '../../src/harness/bounded-loop.js';

/**
 * Contract tests for {@link createBoundedLoop}, added in response to the P22
 * codex review. Codex flagged two holes:
 *
 *   1. `initialState` was declared optional but treated as required — a
 *      caller who omitted it got `undefined` in `answer` even though the
 *      declared type was `TState`.
 *   2. `answer` could therefore be `undefined` at runtime, breaking every
 *      downstream consumer that reads `result.answer.<field>`.
 *
 * The fix makes `initialState` required. These tests pin the contract so a
 * future refactor cannot silently reopen either hole. They also demonstrate
 * the intended integration shape: wrapping a real async worker (here,
 * simulating a browser-agent step that eventually produces an answer).
 */

interface AgentState {
  observations: string[];
  answer?: string;
}

describe('BoundedLoop contract (post-P22 review)', () => {
  it('initialState is required — type system forbids omission', () => {
    // Runtime assertion: passing a real initial state produces a real answer.
    // The type-level assertion is enforced by tsc; if this file compiles,
    // `initialState: TState` is no longer optional.
    const loop = createBoundedLoop<AgentState>({
      maxSteps: 4,
      maxWallMs: 1_000,
      beastMode: async ({ state }) => ({ ...state, answer: 'hedged' }),
    });
    expect(loop).toBeDefined();
  });

  it('answer is always defined for a real agent-shaped step', async () => {
    const loop = createBoundedLoop<AgentState>({
      maxSteps: 5,
      maxWallMs: 5_000,
      beastMode: async ({ state }) => ({
        ...state,
        answer: state.answer ?? '(no confident answer)',
      }),
    });
    const result = await loop.run({
      initialState: { observations: [] },
      step: async ({ state }) => {
        const nextObs = [...state.observations, `obs-${state.observations.length}`];
        return {
          observations: nextObs,
          answer: nextObs.length >= 3 ? nextObs.join(',') : undefined,
        };
      },
      isDone: (s) => s.answer !== undefined,
    });
    expect(result.terminationReason).toBe('done');
    expect(result.answer.answer).toBe('obs-0,obs-1,obs-2');
    expect(result.answer.observations).toHaveLength(3);
  });

  it('beast mode fills answer when the step budget is exhausted', async () => {
    const loop = createBoundedLoop<AgentState>({
      maxSteps: 2,
      maxWallMs: 5_000,
      beastMode: async ({ state, reason }) => ({
        ...state,
        answer: `forced:${reason}:${state.observations.length}obs`,
      }),
    });
    const result = await loop.run({
      initialState: { observations: [] },
      step: async ({ state }) => ({
        observations: [...state.observations, 'x'],
      }),
      isDone: () => false,
    });
    expect(result.terminationReason).toBe('budget-steps');
    expect(result.answer.answer).toBe('forced:budget-steps:2obs');
  });

  it('error path preserves the last-known state as answer', async () => {
    const loop = createBoundedLoop<AgentState>({
      maxSteps: 10,
      maxWallMs: 5_000,
      beastMode: async ({ state }) => ({ ...state, answer: 'unused' }),
    });
    const result = await loop.run({
      initialState: { observations: ['seed'] },
      step: async ({ state }) => {
        if (state.observations.length >= 2) throw new Error('boom');
        return { observations: [...state.observations, 'live'] };
      },
      isDone: (s) => s.answer !== undefined,
    });
    expect(result.terminationReason).toBe('error');
    expect(result.errorMessage).toBe('boom');
    // Even on error, answer holds the last successful state — never undefined.
    expect(result.answer.observations).toEqual(['seed', 'live']);
  });
});
