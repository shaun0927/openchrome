/**
 * Pilot-tier skill graph executor — barrel export.
 *
 * This subdirectory is dynamically imported via
 * `src/pilot/index.ts` → `bootstrapPilot()` in `src/harness/flags.ts`, and is
 * only loaded when the operator passes `--pilot` (or sets `OPENCHROME_PILOT`).
 * Within the pilot tier, behavioural use is gated by
 * `isStateGraphEnabled()` (env `OPENCHROME_STATE_GRAPH`) — call sites MUST
 * check the flag before invoking `decide()` so a host can keep the state
 * graph family closed while running with other pilot families open.
 *
 * Surface is intentionally narrow: one pure function + its option
 * constants + the input/output types. No singleton state, no I/O on import.
 */

export {
  decide,
  DISTRIBUTION_MATCH_THRESHOLD,
  RECOMMEND_RATE_FLOOR,
  SMALL_SAMPLE_TOTAL,
} from './executor.js';

export type {
  ExecutorAction,
  ExecutorDecision,
  ExecutorDecisionKind,
  ExecutorInput,
} from './types.js';
