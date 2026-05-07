import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { recordSuccessfulRun } from '../../src/skill-memory/extractor';
import {
  SkillRecallStore,
  buildRecallPayload,
  isRecallEnabled,
  recallFromDisk,
} from '../../src/skill-memory/recall';
import type { SkillRecord } from '../../src/skill-memory/types';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recall-'));
}

const FIXED_NOW = Date.parse('2026-05-08T12:00:00Z');

function seed(rootDir: string, domain: string, count: number, status: 'candidate' | 'promoted'): void {
  for (let i = 0; i < count; i++) {
    // Force `verified_runs` past the promotion threshold for promoted seeds.
    const runs = status === 'promoted' ? 5 : 1;
    let now = FIXED_NOW + i * 1000;
    for (let r = 0; r < runs; r++) {
      recordSuccessfulRun(
        {
          txn_id: `t-${i}-${r}`,
          contract_id: `c-${i}`,
          intent: `Skill number ${i}`,
          domain,
          graph_node_anchor: `aa${i}b${i}`,
        },
        { rootDir, now: () => (now += 1000) },
      );
    }
  }
}

describe('isRecallEnabled — env gating', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.OPENCHROME_SKILL_RECALL;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENCHROME_SKILL_RECALL;
    else process.env.OPENCHROME_SKILL_RECALL = prev;
  });

  test('default (env unset) → enabled (auto)', () => {
    delete process.env.OPENCHROME_SKILL_RECALL;
    expect(isRecallEnabled()).toBe(true);
  });

  test('"off" disables', () => {
    process.env.OPENCHROME_SKILL_RECALL = 'off';
    expect(isRecallEnabled()).toBe(false);
  });

  test('"on" / "auto" / "1" / "true" all enable', () => {
    for (const v of ['on', 'auto', '1', 'true', 'AUTO']) {
      process.env.OPENCHROME_SKILL_RECALL = v;
      expect(isRecallEnabled()).toBe(true);
    }
  });
});

describe('recallFromDisk — basic', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns null when no skills exist for the domain', () => {
    expect(recallFromDisk('amazon.com', { rootDir: root })).toBeNull();
  });

  test('returns null when no promoted skills exist (only candidates)', () => {
    seed(root, 'amazon.com', 2, 'candidate');
    expect(recallFromDisk('amazon.com', { rootDir: root })).toBeNull();
  });

  test('returns payload with promoted skills', () => {
    seed(root, 'amazon.com', 3, 'promoted');
    const r = recallFromDisk('amazon.com', { rootDir: root });
    expect(r).not.toBeNull();
    expect(r!.domain).toBe('amazon.com');
    expect(r!.promoted_skills.length).toBeGreaterThan(0);
    expect(r!.promoted_skills.length).toBeLessThanOrEqual(5);
    for (const e of r!.promoted_skills) {
      expect(e.expand_via).toMatch(/^openchrome:\/\/skills\//);
    }
  });

  test('respects OPENCHROME_SKILL_RECALL=off', () => {
    seed(root, 'amazon.com', 3, 'promoted');
    const prev = process.env.OPENCHROME_SKILL_RECALL;
    process.env.OPENCHROME_SKILL_RECALL = 'off';
    try {
      expect(recallFromDisk('amazon.com', { rootDir: root })).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.OPENCHROME_SKILL_RECALL;
      else process.env.OPENCHROME_SKILL_RECALL = prev;
    }
  });
});

describe('buildRecallPayload — ordering', () => {
  test('verified_runs DESC, last_verified_at DESC, skill_id ASC', () => {
    const records: SkillRecord[] = [
      mkRec('aaa', 5, '2026-05-01T00:00:00Z', 'promoted'),
      mkRec('bbb', 5, '2026-05-02T00:00:00Z', 'promoted'),
      mkRec('ccc', 9, '2026-05-01T00:00:00Z', 'promoted'),
    ];
    const r = buildRecallPayload('x.com', records, new Map(), { topK: 5 });
    expect(r!.promoted_skills.map((e) => e.id)).toEqual(['ccc', 'bbb', 'aaa']);
  });

  test('tiebreak by skill_id ASC for stability', () => {
    const records: SkillRecord[] = [
      mkRec('zzz', 3, '2026-05-01T00:00:00Z', 'promoted'),
      mkRec('aaa', 3, '2026-05-01T00:00:00Z', 'promoted'),
    ];
    const r = buildRecallPayload('x.com', records, new Map(), {});
    expect(r!.promoted_skills.map((e) => e.id)).toEqual(['aaa', 'zzz']);
  });

  test('drops candidates / archived', () => {
    const records: SkillRecord[] = [
      mkRec('aaa', 5, '2026-05-01T00:00:00Z', 'candidate'),
      mkRec('bbb', 5, '2026-05-01T00:00:00Z', 'archived'),
      mkRec('ccc', 5, '2026-05-01T00:00:00Z', 'promoted'),
    ];
    const r = buildRecallPayload('x.com', records, new Map(), {});
    expect(r!.promoted_skills.map((e) => e.id)).toEqual(['ccc']);
  });
});

describe('buildRecallPayload — drop policy', () => {
  test('drops from bottom until under maxBytes', () => {
    const records: SkillRecord[] = [];
    for (let i = 0; i < 5; i++) {
      records.push(mkRec(`s${i}`, 5 - i, '2026-05-01T00:00:00Z', 'promoted'));
    }
    const r = buildRecallPayload('x.com', records, new Map(), { maxBytes: 200 });
    expect(r).not.toBeNull();
    // The top-ranked entry (s0, 5 verified_runs) wins; bottom entries dropped.
    expect(r!.promoted_skills[0].id).toBe('s0');
    expect(r!.oversized).toBe(true);
  });

  test('always keeps at least 1 skill (and flags oversized)', () => {
    const records: SkillRecord[] = [
      mkRec('only-one', 5, '2026-05-01T00:00:00Z', 'promoted'),
    ];
    const r = buildRecallPayload('x.com', records, new Map(), { maxBytes: 1 });
    expect(r!.promoted_skills).toHaveLength(1);
    expect(r!.oversized).toBe(true);
  });

  test('no oversized flag when payload fits cleanly', () => {
    const records: SkillRecord[] = [
      mkRec('aaa', 5, '2026-05-01T00:00:00Z', 'promoted'),
    ];
    const r = buildRecallPayload('x.com', records, new Map(), { maxBytes: 8 * 1024 });
    expect(r!.oversized).toBeUndefined();
  });

  test('topK caps the candidate pool', () => {
    const records: SkillRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push(mkRec(`s${i}`, 10 - i, '2026-05-01T00:00:00Z', 'promoted'));
    }
    const r = buildRecallPayload('x.com', records, new Map(), { topK: 3 });
    expect(r!.promoted_skills).toHaveLength(3);
  });
});

describe('SkillRecallStore — frozen snapshot', () => {
  test('first resolve invokes compute; subsequent calls return same reference', () => {
    const store = new SkillRecallStore();
    let calls = 0;
    const r1 = store.resolve('s1', 'amazon.com', () => {
      calls++;
      return { domain: 'amazon.com', promoted_skills: [] };
    });
    const r2 = store.resolve('s1', 'amazon.com', () => {
      calls++;
      return { domain: 'amazon.com', promoted_skills: [{ id: 'updated' } as never] };
    });
    expect(calls).toBe(1);
    expect(r1).toBe(r2);
  });

  test('different sessions get independent snapshots', () => {
    const store = new SkillRecallStore();
    const a = store.resolve('s1', 'amazon.com', () => ({ domain: 'amazon.com', promoted_skills: [] }));
    const b = store.resolve('s2', 'amazon.com', () => ({ domain: 'amazon.com', promoted_skills: [] }));
    expect(a).not.toBe(b);
    expect(store.size()).toBe(2);
  });

  test('different domains get independent snapshots within one session', () => {
    const store = new SkillRecallStore();
    store.resolve('s1', 'a.com', () => ({ domain: 'a.com', promoted_skills: [] }));
    store.resolve('s1', 'b.com', () => ({ domain: 'b.com', promoted_skills: [] }));
    expect(store.size()).toBe(2);
  });

  test('null payloads are also memoized (no recompute)', () => {
    const store = new SkillRecallStore();
    let calls = 0;
    store.resolve('s1', 'a.com', () => {
      calls++;
      return null;
    });
    store.resolve('s1', 'a.com', () => {
      calls++;
      return null;
    });
    expect(calls).toBe(1);
  });

  test('invalidateSession drops all snapshots for that session', () => {
    const store = new SkillRecallStore();
    store.resolve('s1', 'a.com', () => ({ domain: 'a.com', promoted_skills: [] }));
    store.resolve('s1', 'b.com', () => ({ domain: 'b.com', promoted_skills: [] }));
    store.resolve('s2', 'a.com', () => ({ domain: 'a.com', promoted_skills: [] }));
    store.invalidateSession('s1');
    expect(store.size()).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function mkRec(
  skill_id: string,
  verified_runs: number,
  last_verified_at: string,
  status: 'candidate' | 'promoted' | 'archived',
): SkillRecord {
  return {
    skill_id,
    filePath: `/tmp/${skill_id}.md`,
    sidecarPath: `/tmp/${skill_id}.json`,
    frontmatter: {
      schema_version: 1,
      name: skill_id,
      domain: 'x.com',
      intent: 'test',
      status,
      verified_runs,
      last_verified_at,
      contract_ref: 'txn',
      graph_node_anchor: 'a1b2',
      author: 'agent',
    },
    sidecar: {
      schema_version: 1,
      skill_id,
      graph_node_anchor: 'a1b2',
      contract_id: 'cid',
      runs: { count: verified_runs, window_start: '2026-04-01T00:00:00Z', recent: [] },
    },
  };
}
