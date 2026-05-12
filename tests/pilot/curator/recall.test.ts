import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resetFlagsCache } from '../../../src/harness/flags';
import { SkillMemoryStore } from '../../../src/core/skill-memory/store';
import type { SkillRecord } from '../../../src/core/skill-memory/types';
import {
  SkillRecallStore,
  buildRecallPayload,
  rankSkillsForRecall,
} from '../../../src/pilot/curator/recall';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recall-'));
}

function mkRec(
  skillId: string,
  successCount: number,
  lastUsedAt: number,
  domain = 'x.com',
): SkillRecord {
  return {
    skillId,
    domain,
    name: `skill-${skillId}`,
    steps: [],
    contractId: 'cid',
    successCount,
    lastUsedAt,
    frozenSnapshotPath: null,
  };
}

// Ensure pilot flag is active for all tests
beforeEach(() => {
  resetFlagsCache();
  process.env.OPENCHROME_PILOT = '1';
});

afterEach(() => {
  resetFlagsCache();
  delete process.env.OPENCHROME_PILOT;
});

/* ------------------------------------------------------------------ */
/* buildRecallPayload — ordering                                       */
/* ------------------------------------------------------------------ */

describe('buildRecallPayload — ordering', () => {
  test('successCount DESC, lastUsedAt DESC, skillId ASC', () => {
    const records: SkillRecord[] = [
      mkRec('aaa', 5, 1000),
      mkRec('bbb', 5, 2000),
      mkRec('ccc', 9, 1000),
    ];
    const r = buildRecallPayload('x.com', records, { topK: 5 });
    expect(r!.ranked_skills.map((e) => e.skillId)).toEqual(['ccc', 'bbb', 'aaa']);
  });

  test('tiebreak by skillId ASC for stability', () => {
    const records: SkillRecord[] = [
      mkRec('zzz', 3, 1000),
      mkRec('aaa', 3, 1000),
    ];
    const r = buildRecallPayload('x.com', records, {});
    expect(r!.ranked_skills.map((e) => e.skillId)).toEqual(['aaa', 'zzz']);
  });

  test('entries include expand_via URI', () => {
    const records: SkillRecord[] = [mkRec('abc', 5, 1000)];
    const r = buildRecallPayload('x.com', records, {});
    expect(r!.ranked_skills[0].expand_via).toBe('openchrome://skills/x.com/abc');
  });
});

/* ------------------------------------------------------------------ */
/* buildRecallPayload — flag gating                                    */
/* ------------------------------------------------------------------ */

describe('buildRecallPayload — flag gating', () => {
  test('returns null when pilot disabled', () => {
    resetFlagsCache();
    delete process.env.OPENCHROME_PILOT;
    const records: SkillRecord[] = [mkRec('aaa', 5, 1000)];
    const r = buildRecallPayload('x.com', records, {});
    expect(r).toBeNull();
    // restore
    process.env.OPENCHROME_PILOT = '1';
    resetFlagsCache();
  });

  test('returns null for empty records list', () => {
    expect(buildRecallPayload('x.com', [], {})).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* buildRecallPayload — drop policy                                    */
/* ------------------------------------------------------------------ */

describe('buildRecallPayload — drop policy', () => {
  test('drops from bottom until under maxBytes', () => {
    const records: SkillRecord[] = [];
    for (let i = 0; i < 5; i++) {
      records.push(mkRec(`s${i}`, 5 - i, 1000));
    }
    const r = buildRecallPayload('x.com', records, { maxBytes: 200 });
    expect(r).not.toBeNull();
    expect(r!.ranked_skills[0].skillId).toBe('s0');
    expect(r!.oversized).toBe(true);
  });

  test('always keeps at least 1 skill and flags oversized', () => {
    const records: SkillRecord[] = [mkRec('only-one', 5, 1000)];
    const r = buildRecallPayload('x.com', records, { maxBytes: 1 });
    expect(r!.ranked_skills).toHaveLength(1);
    expect(r!.oversized).toBe(true);
  });

  test('no oversized flag when payload fits cleanly', () => {
    const records: SkillRecord[] = [mkRec('aaa', 5, 1000)];
    const r = buildRecallPayload('x.com', records, { maxBytes: 8 * 1024 });
    expect(r!.oversized).toBeUndefined();
  });

  test('truncated payload with oversized flag stays within maxBytes', () => {
    const records: SkillRecord[] = [];
    for (let i = 0; i < 8; i++) {
      records.push(mkRec(`skill${i}`, 8 - i, 1000));
    }
    for (let cap = 250; cap <= 600; cap += 5) {
      const r = buildRecallPayload('x.com', records, { maxBytes: cap });
      expect(r).not.toBeNull();
      const size = Buffer.byteLength(JSON.stringify(r), 'utf8');
      if (r!.ranked_skills.length > 1) {
        expect(size).toBeLessThanOrEqual(cap);
      }
      if (r!.ranked_skills.length < records.length) {
        expect(r!.oversized).toBe(true);
      }
    }
  });

  test('honors caller maxBytes below default floor', () => {
    const records: SkillRecord[] = [];
    for (let i = 0; i < 4; i++) {
      records.push(mkRec(`s${i}`, 4 - i, 1000));
    }
    const tiny = buildRecallPayload('x.com', records, { maxBytes: 10 });
    expect(tiny).not.toBeNull();
    expect(tiny!.oversized).toBe(true);
    expect(tiny!.ranked_skills).toHaveLength(1);
  });

  test('topK caps the candidate pool', () => {
    const records: SkillRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push(mkRec(`s${i}`, 10 - i, 1000));
    }
    const r = buildRecallPayload('x.com', records, { topK: 3 });
    expect(r!.ranked_skills).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ */
/* SkillRecallStore — frozen snapshot                                  */
/* ------------------------------------------------------------------ */

describe('SkillRecallStore — frozen snapshot', () => {
  test('first resolve invokes compute; subsequent calls return same reference', () => {
    const store = new SkillRecallStore();
    let calls = 0;
    const r1 = store.resolve('s1', 'amazon.com', () => {
      calls++;
      return { domain: 'amazon.com', ranked_skills: [] };
    });
    const r2 = store.resolve('s1', 'amazon.com', () => {
      calls++;
      return { domain: 'amazon.com', ranked_skills: [{ skillId: 'updated' } as never] };
    });
    expect(calls).toBe(1);
    expect(r1).toBe(r2);
  });

  test('different sessions get independent snapshots', () => {
    const store = new SkillRecallStore();
    const a = store.resolve('s1', 'amazon.com', () => ({ domain: 'amazon.com', ranked_skills: [] }));
    const b = store.resolve('s2', 'amazon.com', () => ({ domain: 'amazon.com', ranked_skills: [] }));
    expect(a).not.toBe(b);
    expect(store.size()).toBe(2);
  });

  test('different domains get independent snapshots within one session', () => {
    const store = new SkillRecallStore();
    store.resolve('s1', 'a.com', () => ({ domain: 'a.com', ranked_skills: [] }));
    store.resolve('s1', 'b.com', () => ({ domain: 'b.com', ranked_skills: [] }));
    expect(store.size()).toBe(2);
  });

  test('null payloads are also memoized (no recompute)', () => {
    const store = new SkillRecallStore();
    let calls = 0;
    store.resolve('s1', 'a.com', () => { calls++; return null; });
    store.resolve('s1', 'a.com', () => { calls++; return null; });
    expect(calls).toBe(1);
  });

  test('invalidateSession drops all snapshots for that session', () => {
    const store = new SkillRecallStore();
    store.resolve('s1', 'a.com', () => ({ domain: 'a.com', ranked_skills: [] }));
    store.resolve('s1', 'b.com', () => ({ domain: 'b.com', ranked_skills: [] }));
    store.resolve('s2', 'a.com', () => ({ domain: 'a.com', ranked_skills: [] }));
    store.invalidateSession('s1');
    expect(store.size()).toBe(1);
  });

  test('clear() drops all snapshots', () => {
    const store = new SkillRecallStore();
    store.resolve('s1', 'a.com', () => ({ domain: 'a.com', ranked_skills: [] }));
    store.resolve('s2', 'b.com', () => ({ domain: 'b.com', ranked_skills: [] }));
    store.clear();
    expect(store.size()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* rankSkillsForRecall — integration with SkillMemoryStore            */
/* ------------------------------------------------------------------ */

describe('rankSkillsForRecall — store integration', () => {
  let root: string;

  beforeEach(() => {
    root = tempRoot();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function seedStore(domain: string, count: number, baseSuccess = 1): Promise<void> {
    const store = new SkillMemoryStore({ domain, rootDir: root });
    for (let i = 0; i < count; i++) {
      const result = await store.record({
        domain,
        name: `skill-${i}`,
        steps: [],
        contractId: `cid-${i}`,
        successCount: baseSuccess + i,
        lastUsedAt: Date.now() + i * 1000,
        frozenSnapshotPath: null,
      });
      // bump success so list returns non-trivial ordering
      await store.markUsed(result.skill_id, Date.now() + i * 1000, true);
    }
  }

  test('returns null when no skills stored', () => {
    const r = rankSkillsForRecall({ domain: 'empty.com' }, { rootDir: root });
    expect(r).toBeNull();
  });

  test('returns null when pilot disabled', () => {
    resetFlagsCache();
    delete process.env.OPENCHROME_PILOT;
    const r = rankSkillsForRecall({ domain: 'x.com' }, { rootDir: root });
    expect(r).toBeNull();
    process.env.OPENCHROME_PILOT = '1';
    resetFlagsCache();
  });

  test('returns ranked payload for stored skills', async () => {
    await seedStore('amazon.com', 3);
    const r = rankSkillsForRecall({ domain: 'amazon.com' }, { rootDir: root });
    expect(r).not.toBeNull();
    expect(r!.domain).toBe('amazon.com');
    expect(r!.ranked_skills.length).toBeGreaterThan(0);
    // Top skill should be highest successCount
    const scores = r!.ranked_skills.map((s) => s.successCount);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  test('respects topK option', async () => {
    await seedStore('x.com', 10);
    const r = rankSkillsForRecall({ domain: 'x.com' }, { rootDir: root, topK: 3 });
    expect(r).not.toBeNull();
    expect(r!.ranked_skills.length).toBeLessThanOrEqual(3);
  });

  test('each entry has expand_via URI', async () => {
    await seedStore('y.com', 2);
    const r = rankSkillsForRecall({ domain: 'y.com' }, { rootDir: root });
    expect(r).not.toBeNull();
    for (const entry of r!.ranked_skills) {
      expect(entry.expand_via).toMatch(/^openchrome:\/\/skills\/y\.com\//);
    }
  });
});
