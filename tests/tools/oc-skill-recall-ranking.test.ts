/**
 * Replay-aware ranking for `oc_skill_recall` (#856 invariant #4).
 *
 * Verifies the computeReplaySignal bucket and the (signal desc, recency
 * desc, skillId asc) ordering. Uses SkillMemoryStore directly to construct
 * a controlled fixture and asserts the order via `computeReplaySignal`
 * plus a direct sort of `store.list()` matching the recall tool's logic.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SkillMemoryStore, type SkillRecord } from '../../src/core/skill-memory';
import { computeReplaySignal, projectCodegenReplay } from '../../src/tools/oc-skill-recall';

const DOMAIN = 'ranking.test';

async function withStore(
  fn: (store: SkillMemoryStore, rootDir: string) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'oc-recall-rank-'));
  const store = new SkillMemoryStore({ domain: DOMAIN, rootDir });
  try {
    await fn(store, rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

describe('computeReplaySignal', () => {
  test('returns 0 when no replay record exists', () => {
    const s = baseSkill({ skillId: 'a'.repeat(16) });
    expect(computeReplaySignal(s)).toBe(0);
  });

  test('returns +1 when last passed > last failed', () => {
    const s = baseSkill({
      skillId: 'a'.repeat(16),
      lastReplayPassedAt: 200,
      lastReplayFailedAt: 100,
    });
    expect(computeReplaySignal(s)).toBe(1);
  });

  test('returns -1 when last failed > last passed', () => {
    const s = baseSkill({
      skillId: 'a'.repeat(16),
      lastReplayPassedAt: 100,
      lastReplayFailedAt: 200,
    });
    expect(computeReplaySignal(s)).toBe(-1);
  });

  test('returns 0 when timestamps tie (degenerate)', () => {
    const s = baseSkill({
      skillId: 'a'.repeat(16),
      lastReplayPassedAt: 500,
      lastReplayFailedAt: 500,
    });
    expect(computeReplaySignal(s)).toBe(0);
  });
});

describe('oc_skill_recall ranking order', () => {
  test('PASS skills surface above never-replayed, which surface above FAILED', async () => {
    await withStore(async (store) => {
      // Three skills, identical recency to isolate the signal axis.
      const passed = await store.record(rec('passed', 'a'.repeat(16)));
      const neutral = await store.record(rec('neutral', 'b'.repeat(16)));
      const failed = await store.record(rec('failed', 'c'.repeat(16)));

      await store.recordReplayResult(passed.skill_id, { passedAt: 1000 });
      await store.recordReplayResult(failed.skill_id, { failedAt: 1000 });

      const ranked = applyRecallRanking(store.list({}));
      expect(ranked.map((r) => r.name)).toEqual(['passed', 'neutral', 'failed']);
    });
  });

  test('within the same bucket, more-recent lastUsedAt wins', async () => {
    await withStore(async (store) => {
      // Two never-replayed skills, but one is more recently used.
      await store.record(rec('older', 'a'.repeat(16)));
      await store.record(rec('newer', 'b'.repeat(16)));

      // Bump 'newer' to be the most-recently used.
      await new Promise((r) => setTimeout(r, 5));
      await store.markUsed(
        store.list({}).find((s) => s.name === 'newer')!.skillId,
        Date.now(),
        true,
      );

      const ranked = applyRecallRanking(store.list({}));
      expect(ranked.map((r) => r.name)).toEqual(['newer', 'older']);
    });
  });

  test('FAILED demotion holds even when the failed skill is more recently used', async () => {
    await withStore(async (store) => {
      // The failed skill is more recently used than the passed one — the
      // signal bucket still dominates.
      const passed = await store.record(rec('passed', 'a'.repeat(16)));
      const failed = await store.record(rec('failed', 'b'.repeat(16)));
      await store.recordReplayResult(passed.skill_id, { passedAt: 1000 });
      await store.recordReplayResult(failed.skill_id, { failedAt: 1000 });
      // Bump failed's recency so it would normally outrank.
      await new Promise((r) => setTimeout(r, 5));
      await store.markUsed(failed.skill_id, Date.now(), true);

      const ranked = applyRecallRanking(store.list({}));
      expect(ranked[0].name).toBe('passed');
      expect(ranked[1].name).toBe('failed');
    });
  });
});

function baseSkill(overrides: Partial<SkillRecord>): SkillRecord {
  return {
    skillId: 'x'.repeat(16),
    domain: DOMAIN,
    name: 'fixture',
    steps: [],
    contractId: 'noop',
    successCount: 0,
    lastUsedAt: 0,
    frozenSnapshotPath: null,
    ...overrides,
  } as SkillRecord;
}

function rec(name: string, _skillIdHint: string) {
  return {
    domain: DOMAIN,
    name,
    steps: [],
    contractId: 'noop',
    frozenSnapshotPath: null,
    successCount: 0,
    lastUsedAt: 0,
  };
}

/**
 * Reproduces the ranking logic implemented in `src/tools/oc-skill-recall.ts`
 * so the test is decoupled from MCP plumbing.
 */
function applyRecallRanking(rows: SkillRecord[]): SkillRecord[] {
  return rows.slice().sort((a, b) => {
    const sa = computeReplaySignal(a);
    const sb = computeReplaySignal(b);
    if (sa !== sb) return sb - sa;
    if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
    return a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0;
  });
}

describe('projectCodegenReplay (#1430 LLM-free fast path)', () => {
  test('available=true with artifacts surfaced when the skill has codegen output', () => {
    const artifact = {
      kind: 'playwright' as const,
      path: 'skills/ranking.test/c.codegen.spec.ts',
      created_at: 1700000000000,
    };
    const s = baseSkill({ skillId: 'c'.repeat(16), codegenArtifacts: [artifact] });
    expect(projectCodegenReplay(s)).toEqual({ available: true, artifacts: [artifact] });
  });

  test('available=false with empty artifacts when codegen was disabled at record time', () => {
    expect(projectCodegenReplay(baseSkill({ codegenArtifacts: [] }))).toEqual({ available: false, artifacts: [] });
    // Legacy records without the field at all also fall back cleanly.
    expect(projectCodegenReplay(baseSkill({}))).toEqual({ available: false, artifacts: [] });
  });
});
