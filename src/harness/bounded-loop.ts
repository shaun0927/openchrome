/**
 * Bounded loop budget with Beast Mode forced answer.
 *
 * The jina node-DeepResearch loop and deer-flow "lead → parallel
 * subagents → synthesis" pattern share one design decision that
 * openchrome does not yet formalise: *every* agent loop must terminate,
 * and it must terminate with an answer — even a hedged one — rather
 * than silently exhausting a step budget. Silent exhaustion is the
 * most common failure mode in long-horizon browser agents because it
 * looks identical to "still working" from the caller's side.
 *
 * This module encodes the pattern as a small orchestration helper:
 *
 *   const loop = createBoundedLoop({
 *     maxSteps: 20,
 *     maxWallMs: 5 * 60_000,
 *     beastMode: async ({ state, reason }) => finaliseHedged(state),
 *   });
 *   const result = await loop.run({
 *     step: async ({ state, stepIndex }) => nextStep(state),
 *     isDone: (state) => state.answer !== undefined,
 *   });
 *
 * `result.terminationReason` explicitly reports why the loop stopped
 * (`done`, `budget-steps`, `budget-wall`, `error`), and `result.answer`
 * is *always* set — either by a normal `isDone` return, or by the
 * caller-supplied `beastMode` hook. That combination is what makes
 * loop exhaustion recoverable at the caller layer.
 *
 * The helper is dependency-free and holds no state. All timing is
 * injected so tests can run instantly.
 *
 * Clean-room. Idea attribution per docs/rebirth/ULTIMATE-CENSUS-2026-07-18:
 * jina node-DeepResearch (C10) bounded loop + Beast Mode, deer-flow (C9)
 * parallel subagent idiom. No code copied.
 */

export interface BoundedLoopOptions<TState> {
  /** Absolute step ceiling. Default 32. */
  maxSteps?: number;
  /**
   * Wall-clock ceiling in ms. Default 5 minutes. The loop checks the wall
   * budget between steps; a runaway `step` implementation is the caller's
   * problem.
   */
  maxWallMs?: number;
  /**
   * Forced-answer producer. Runs when the loop hits either budget without
   * `isDone` becoming true. Must not throw — throwing forfeits the answer
   * and the loop returns `terminationReason: 'error'`.
   */
  beastMode: (input: BeastModeInput<TState>) => Promise<TState>;
  /** Injected clock, primarily for tests. */
  now?: () => number;
}

export interface BeastModeInput<TState> {
  state: TState;
  reason: 'budget-steps' | 'budget-wall';
  stepsUsed: number;
  wallMsUsed: number;
}

export interface BoundedLoopStepInput<TState> {
  state: TState;
  stepIndex: number;
  wallMsUsed: number;
}

export interface BoundedLoopRunInput<TState> {
  initialState?: TState;
  step: (input: BoundedLoopStepInput<TState>) => Promise<TState>;
  isDone: (state: TState) => boolean;
}

export type BoundedLoopTermination = 'done' | 'budget-steps' | 'budget-wall' | 'error';

export interface BoundedLoopResult<TState> {
  answer: TState;
  terminationReason: BoundedLoopTermination;
  stepsUsed: number;
  wallMsUsed: number;
  errorMessage?: string;
}

const DEFAULT_MAX_STEPS = 32;
const DEFAULT_MAX_WALL_MS = 5 * 60_000;

export interface BoundedLoop<TState> {
  run(input: BoundedLoopRunInput<TState>): Promise<BoundedLoopResult<TState>>;
}

export function createBoundedLoop<TState>(
  options: BoundedLoopOptions<TState>,
): BoundedLoop<TState> {
  const maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS);
  const maxWallMs = Math.max(1, options.maxWallMs ?? DEFAULT_MAX_WALL_MS);
  const now = options.now ?? Date.now;
  const beastMode = options.beastMode;

  return {
    async run(input) {
      const startedAt = now();
      let state = input.initialState as TState;
      let stepsUsed = 0;
      let wallMsUsed = 0;

      while (true) {
        wallMsUsed = now() - startedAt;
        if (input.isDone(state)) {
          return {
            answer: state,
            terminationReason: 'done',
            stepsUsed,
            wallMsUsed,
          };
        }
        if (stepsUsed >= maxSteps) {
          return forceAnswer(state, 'budget-steps', stepsUsed, wallMsUsed, beastMode);
        }
        if (wallMsUsed >= maxWallMs) {
          return forceAnswer(state, 'budget-wall', stepsUsed, wallMsUsed, beastMode);
        }
        try {
          state = await input.step({ state, stepIndex: stepsUsed, wallMsUsed });
        } catch (error) {
          return {
            answer: state,
            terminationReason: 'error',
            stepsUsed,
            wallMsUsed,
            errorMessage: error instanceof Error ? error.message : String(error),
          };
        }
        stepsUsed += 1;
      }
    },
  };
}

async function forceAnswer<TState>(
  state: TState,
  reason: 'budget-steps' | 'budget-wall',
  stepsUsed: number,
  wallMsUsed: number,
  beastMode: BoundedLoopOptions<TState>['beastMode'],
): Promise<BoundedLoopResult<TState>> {
  try {
    const forced = await beastMode({ state, reason, stepsUsed, wallMsUsed });
    return {
      answer: forced,
      terminationReason: reason,
      stepsUsed,
      wallMsUsed,
    };
  } catch (error) {
    return {
      answer: state,
      terminationReason: 'error',
      stepsUsed,
      wallMsUsed,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
