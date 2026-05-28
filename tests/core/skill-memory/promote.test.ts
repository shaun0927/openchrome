/**
 * Tests for the fresh-lane skill promotion procedure (#1431 Part 3).
 *
 * The procedure is dependency-injected so we can drive every branch
 * without launching Chrome. The fakes here implement the same contract
 * the real wiring will: a scratch lane factory, a replay runner, and a
 * clock.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SkillMemoryStore,
  type SkillRecord,
} from '../../../src/core/skill-memory';
import {
  promoteSkill,
  type PromoteSkillDeps,
} from '../../../src/core/skill-memory/promote';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-promote-'));
}

function makeDeps(
  override: Partial<PromoteSkillDeps> & {
    outcome?: 'PASS' | 'STEP_FAIL' | 'CONTRACT_FAIL' | 'PRECONDITION_FAIL';
    failOpen?: boolean;
    throwOnReplay?: boolean;
  } = {},
): PromoteSkillDeps & { events: Array<{ stage: string; skillId: string }> } {
  const events: Array<{ stage: string; skillId: string }> = [];
  return {
    events,
    openScratchLane: async () => {
      if (override.failOpen) throw new Error('lane allocation refused');
      return { laneId: 'lane-1', taskId: 'task-1' };
    },
    closeScratchLane: async () => {
      // no-op
    },
    replayInLane: async () => {
      if (override.throwOnReplay) throw new Error('boom');
      return { outcome: override.outcome ?? 'PASS' };
    },
    now: () => 1_000,
    log: (e) => events.push({ stage: e.stage, skillId: e.skillId }),
  };
}

describe('promoteSkill (#1431 Part 3)', () => {
  let root: string;
  let store: SkillMemoryStore;

  beforeEach(() => {
    root = tempRoot();
    // Inject rootDir explicitly rather than mutating process.env.HOME:
    // os.homedir() reads USERPROFILE (not HOME) on Windows, so the env
    // trick would write to the real home there. The store accepts rootDir.
    store = new SkillMemoryStore({ domain: 'amazon.com', rootDir: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function recordSkill(name: string): Promise<string> {
    const r = await store.record({
      domain: 'amazon.com',
      name,
      steps: [{ kind: 'click' }],
      contractId: 'contract-1',
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: null,
    } as Omit<SkillRecord, 'skillId'>);
    return r.skill_id;
  }

  it('promotes recorded → recallable on a PASS replay', async () => {
    const id = await recordSkill('a');
    const deps = makeDeps({ outcome: 'PASS' });
    const r = await promoteSkill(store, id, deps);
    expect(r).toEqual({ promoted: true, from: 'recorded', to: 'recallable' });
    expect(store.get(id)?.promotionState).toBe('recallable');
    // Observers see open + replay + the re_verified checkpoint (log-only,
    // not persisted) + recallable.
    expect(deps.events.map((e) => e.stage)).toEqual([
      'open_scratch_lane',
      'replay_in_scratch_lane',
      're_verified',
      'recallable',
    ]);
  });

  it('quarantines on a STEP_FAIL outcome', async () => {
    const id = await recordSkill('a');
    const r = await promoteSkill(store, id, makeDeps({ outcome: 'STEP_FAIL' }));
    expect(r.promoted).toBe(false);
    if (!r.promoted) expect(r.quarantined).toBe(true);
    expect(store.get(id)?.promotionState).toBe('quarantined');
    expect(store.get(id)?.promotionQuarantineReason).toMatch(/STEP_FAIL/);
  });

  it('quarantines on a CONTRACT_FAIL outcome', async () => {
    const id = await recordSkill('a');
    const r = await promoteSkill(store, id, makeDeps({ outcome: 'CONTRACT_FAIL' }));
    expect(r.promoted).toBe(false);
    expect(store.get(id)?.promotionState).toBe('quarantined');
  });

  it('does NOT quarantine on lane-open failure (infra fault)', async () => {
    const id = await recordSkill('a');
    const r = await promoteSkill(store, id, makeDeps({ failOpen: true }));
    expect(r.promoted).toBe(false);
    if (!r.promoted) expect(r.quarantined).toBe(false);
    expect(store.get(id)?.promotionState).toBe('recorded');
  });

  it('does NOT quarantine when replay throws (treated as infra fault)', async () => {
    const id = await recordSkill('a');
    const r = await promoteSkill(store, id, makeDeps({ throwOnReplay: true }));
    expect(r.promoted).toBe(false);
    if (!r.promoted) expect(r.quarantined).toBe(false);
    expect(store.get(id)?.promotionState).toBe('recorded');
  });

  it('is a no-op success when the skill is already recallable', async () => {
    const id = await recordSkill('a');
    await store.setPromotionState(id, 'recallable', 100);
    const deps = makeDeps({ outcome: 'STEP_FAIL' }); // would normally quarantine
    const r = await promoteSkill(store, id, deps);
    expect(r.promoted).toBe(true);
    expect(deps.events.find((e) => e.stage === 'noop_already_recallable')).toBeDefined();
    expect(store.get(id)?.promotionState).toBe('recallable');
  });

  it('refuses to re-promote a quarantined skill', async () => {
    const id = await recordSkill('a');
    await store.setPromotionState(id, 'quarantined', 100, 'previous run');
    const r = await promoteSkill(store, id, makeDeps({ outcome: 'PASS' }));
    expect(r.promoted).toBe(false);
    if (!r.promoted) {
      expect(r.quarantined).toBe(true);
      expect(r.reason).toMatch(/previous run/);
    }
  });

  it('returns a structured error for unknown skill_id', async () => {
    const r = await promoteSkill(store, 'deadbeefdeadbeef', makeDeps());
    expect(r.promoted).toBe(false);
    if (!r.promoted) {
      expect(r.quarantined).toBe(false);
      expect(r.reason).toMatch(/unknown skill_id/);
    }
  });

  it('caps an overlong quarantine reason in the returned outcome', async () => {
    const id = await recordSkill('a');
    const deps = makeDeps();
    deps.replayInLane = async () => ({ outcome: 'CONTRACT_FAIL', reason: 'x'.repeat(900) });
    const r = await promoteSkill(store, id, deps);
    expect(r.promoted).toBe(false);
    if (!r.promoted) expect(r.reason.length).toBeLessThanOrEqual(512);
    expect(store.get(id)?.promotionQuarantineReason?.length).toBeLessThanOrEqual(512);
  });

  it('logs close_scratch_lane_failed without changing the outcome', async () => {
    const id = await recordSkill('a');
    const deps = makeDeps({ outcome: 'PASS' });
    deps.closeScratchLane = async () => {
      throw new Error('rm -rf failed');
    };
    const r = await promoteSkill(store, id, deps);
    expect(r.promoted).toBe(true);
    expect(store.get(id)?.promotionState).toBe('recallable');
    expect(deps.events.find((e) => e.stage === 'close_scratch_lane_failed')).toBeDefined();
  });
});
