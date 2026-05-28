/**
 * Fresh-lane skill promotion procedure (#1431 Part 3).
 *
 * Bridges Parts 1 (scratch-profile browser lanes) and 2 (promotion
 * state on SkillMemoryStore) into a single host-callable routine.
 *
 * The procedure is deliberately dependency-injected: the production
 * wiring will pass in a scratch-lane factory that produces a
 * BrowserLane via `createBrowserLane({ profile: 'scratch' })` and a
 * replay runner that drives `oc_skill_replay` against that lane. Tests
 * pass deterministic fakes so the algorithm can be exercised without
 * starting Chrome.
 *
 * Outcomes:
 *   - replay PASS  → setPromotionState(skillId, 're_verified', now)
 *                    and then setPromotionState(skillId, 'recallable', now)
 *                    in the same call. The two-step rotation gives
 *                    observers a transient `re_verified` checkpoint they
 *                    can monitor without changing semantics.
 *   - replay FAIL  → setPromotionState(skillId, 'quarantined', now, reason).
 *
 * SSOT (#1359) alignment: the procedure never calls a model. It only
 * orchestrates the deterministic replay + contract check that already
 * lives in oc_skill_replay (#856), in a clean profile guaranteed by
 * Part 1 of this issue.
 */
import type { SkillMemoryStore } from './store';

export interface PromoteSkillDeps {
  /** Allocate a scratch lane and return an opaque handle. */
  openScratchLane(): Promise<{ laneId: string; taskId: string }>;
  /** Close the scratch lane (also rm-rfs its profile dir per #1431 Part 1). */
  closeScratchLane(handle: { laneId: string; taskId: string }): Promise<void>;
  /**
   * Replay the recorded skill in the scratch lane and gate on its
   * contract. PASS means both the steps and the contract held.
   */
  replayInLane(
    handle: { laneId: string; taskId: string },
    skillId: string,
  ): Promise<{ outcome: 'PASS' | 'STEP_FAIL' | 'CONTRACT_FAIL' | 'PRECONDITION_FAIL'; reason?: string }>;
  /** Wall-clock injection for deterministic tests. */
  now(): number;
  /** Optional logger; defaults to no-op. */
  log?: (event: { stage: string; skillId: string; details?: unknown }) => void;
}

export type PromotionOutcome =
  // `from` is the actual prior state the skill was in. Narrow the two
  // failure variants with `r.quarantined === true`, NOT `'quarantined' in r`
  // — both carry the field, so an `in` check is always true.
  | { promoted: true; from: 'recorded' | 're_verified' | 'recallable'; to: 'recallable' }
  | { promoted: false; quarantined: true; reason: string }
  | { promoted: false; quarantined: false; reason: string };

/** Quarantine reasons are capped to match the store's own on-disk limit. */
const MAX_REASON_LEN = 512;

export async function promoteSkill(
  store: SkillMemoryStore,
  skillId: string,
  deps: PromoteSkillDeps,
): Promise<PromotionOutcome> {
  const log = deps.log ?? (() => {});
  const existing = store.get(skillId);
  if (!existing) {
    return {
      promoted: false,
      quarantined: false,
      reason: `unknown skill_id=${skillId}`,
    };
  }

  // Idempotency: already promoted skills are a no-op success.
  if (existing.promotionState === 'recallable') {
    log({ stage: 'noop_already_recallable', skillId });
    return { promoted: true, from: 'recallable', to: 'recallable' };
  }

  if (existing.promotionState === 'quarantined') {
    return {
      promoted: false,
      quarantined: true,
      reason: existing.promotionQuarantineReason ?? 'previously quarantined',
    };
  }

  log({ stage: 'open_scratch_lane', skillId });
  let lane: { laneId: string; taskId: string };
  try {
    lane = await deps.openScratchLane();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log({ stage: 'open_scratch_lane_failed', skillId, details: reason });
    // We do NOT quarantine here — infra failures are not the skill's
    // fault. The host can retry later.
    return { promoted: false, quarantined: false, reason: `lane_open_failed: ${reason}` };
  }

  let outcome: { outcome: string; reason?: string };
  try {
    log({ stage: 'replay_in_scratch_lane', skillId });
    outcome = await deps.replayInLane(lane, skillId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log({ stage: 'replay_threw', skillId, details: reason });
    await closeLane(deps, lane, skillId, log);
    return { promoted: false, quarantined: false, reason: `replay_threw: ${reason}` };
  }

  // Always close the scratch lane.
  await closeLane(deps, lane, skillId, log);

  if (outcome.outcome !== 'PASS') {
    const reason = capReason(`${outcome.outcome}: ${outcome.reason ?? 'no reason'}`);
    log({ stage: 'quarantine', skillId, details: reason });
    await store.setPromotionState(skillId, 'quarantined', deps.now(), reason);
    return { promoted: false, quarantined: true, reason };
  }

  // PASS path: write the durable record straight to `recallable` in a single
  // store write. The `re_verified` checkpoint is emitted as a log event for
  // observers, not persisted — a two-write rotation could strand the skill at
  // `re_verified` permanently if the process died between the writes.
  const from = existing.promotionState ?? 'recorded';
  log({ stage: 're_verified', skillId });
  await store.setPromotionState(skillId, 'recallable', deps.now());
  log({ stage: 'recallable', skillId });
  return { promoted: true, from, to: 'recallable' };
}

function capReason(reason: string): string {
  return reason.length > MAX_REASON_LEN ? reason.slice(0, MAX_REASON_LEN) : reason;
}

async function closeLane(
  deps: PromoteSkillDeps,
  lane: { laneId: string; taskId: string },
  skillId: string,
  log: NonNullable<PromoteSkillDeps['log']>,
): Promise<void> {
  // A failed close must not change the promotion outcome, but a silent
  // swallow hides scratch-profile/disk leaks. Surface it on the log stream.
  await deps.closeScratchLane(lane).catch((err: unknown) => {
    log({
      stage: 'close_scratch_lane_failed',
      skillId,
      details: err instanceof Error ? err.message : String(err),
    });
  });
}
