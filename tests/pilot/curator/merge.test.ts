import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  clusterSkills,
  jaccard,
  runMerge,
  tokenize,
} from '../../../src/pilot/curator/merge';
import {
  computeSkillId,
  listSkillsForDomain,
  recordSuccessfulRun,
} from '../../../src/pilot/curator/extractor';
import { parseSkillMd } from '../../../src/pilot/curator/skill-md';
import { SKILL_RUN_LOG_MAX } from '../../../src/pilot/curator/types';
import type { SkillRecord } from '../../../src/pilot/curator/types';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-merge-'));
}

const FIXED_NOW = Date.parse('2026-05-08T12:00:00Z');

/* ------------------------------------------------------------------ */
/* tokenize / jaccard                                                  */
/* ------------------------------------------------------------------ */

describe('tokenize', () => {
  test('lowercases + strips punctuation + removes stop-words', () => {
    expect(tokenize('Add a Cart Item! And Pay.')).toEqual(new Set(['add', 'cart', 'item', 'pay']));
  });

  test('empty string → empty set', () => {
    expect(tokenize('').size).toBe(0);
  });

  test('all stop-words → empty set', () => {
    expect(tokenize('the a an and to of').size).toBe(0);
  });

  test('Unicode letters preserved', () => {
    expect(tokenize('카트에 추가').has('카트에')).toBe(true);
  });
});

describe('jaccard', () => {
  test('identical sets → 1.0', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  test('disjoint sets → 0', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  test('overlap formula matches expected', () => {
    // {a,b,c} vs {b,c,d} → intersection 2, union 4 → 0.5
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBeCloseTo(0.5);
  });

  test('two empty sets → 1.0 (vacuously equal)', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* clusterSkills                                                       */
/* ------------------------------------------------------------------ */

function rec(
  over: Partial<SkillRecord['frontmatter']> = {},
  sidecarOver: Partial<SkillRecord['sidecar']> = {},
): SkillRecord {
  const skill_id = (over.name ?? 'sk') + '-' + Math.random().toString(36).slice(2, 6);
  return {
    skill_id,
    filePath: `/tmp/${skill_id}.md`,
    sidecarPath: `/tmp/${skill_id}.json`,
    frontmatter: {
      schema_version: 1,
      name: over.name ?? 'sk-x',
      domain: 'amazon.com',
      intent: 'Add cart item and pay',
      status: 'promoted',
      verified_runs: 5,
      last_verified_at: '2026-05-08T12:00:00Z',
      contract_ref: 'txn',
      graph_node_anchor: 'aaaa1234',
      author: 'agent',
      ...over,
    },
    sidecar: {
      schema_version: 1,
      skill_id,
      graph_node_anchor: over.graph_node_anchor ?? 'aaaa1234',
      contract_id: 'cid',
      runs: { count: 5, window_start: '2026-04-01T00:00:00Z', recent: [] },
      ...sidecarOver,
    },
  };
}

describe('clusterSkills — clustering', () => {
  test('skills with same prefix + ≥0.70 Jaccard cluster together', () => {
    const records = [
      rec({ graph_node_anchor: 'aaaa1234', intent: 'Add cart item and pay' }),
      rec({ graph_node_anchor: 'aaaa9999', intent: 'Add cart item, then pay' }),
      rec({ graph_node_anchor: 'bbbb1111', intent: 'Add cart item and pay' }), // diff prefix
    ];
    const clusters = clusterSkills(records, { jaccardThreshold: 0.7, prefixChars: 4 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].records).toHaveLength(2);
  });

  test('skills below Jaccard threshold do not cluster', () => {
    const records = [
      rec({ graph_node_anchor: 'aaaa1234', intent: 'Add cart item and pay' }),
      rec({ graph_node_anchor: 'aaaa9999', intent: 'Search for product' }),
    ];
    expect(clusterSkills(records, { jaccardThreshold: 0.7, prefixChars: 4 })).toHaveLength(0);
  });

  test('user-authored skills are excluded from clustering', () => {
    const records = [
      rec({ graph_node_anchor: 'aaaa1234', intent: 'Add cart item' }),
      rec({ graph_node_anchor: 'aaaa9999', intent: 'Add cart item', author: 'user' }),
    ];
    expect(clusterSkills(records, { jaccardThreshold: 0.7, prefixChars: 4 })).toHaveLength(0);
  });

  test('archived skills are excluded', () => {
    const records = [
      rec({ graph_node_anchor: 'aaaa1234', intent: 'Add cart item' }),
      rec({ graph_node_anchor: 'aaaa9999', intent: 'Add cart item', status: 'archived' }),
    ];
    expect(clusterSkills(records, { jaccardThreshold: 0.7, prefixChars: 4 })).toHaveLength(0);
  });

  test('seed picks highest verified_runs first', () => {
    const records = [
      rec({ graph_node_anchor: 'aaaa1', intent: 'low', verified_runs: 1 }),
      rec({ graph_node_anchor: 'aaaa2', intent: 'low', verified_runs: 5 }),
      rec({ graph_node_anchor: 'aaaa3', intent: 'low', verified_runs: 3 }),
    ];
    const clusters = clusterSkills(records, { jaccardThreshold: 0.7, prefixChars: 4 });
    expect(clusters[0].records[0].frontmatter.verified_runs).toBe(5);
  });

  test('singleton clusters (only seed matches its own prefix) are dropped', () => {
    const records = [rec({ graph_node_anchor: 'aaaa1234', intent: 'unique' })];
    expect(clusterSkills(records)).toHaveLength(0);
  });

  test('skills with same intent/anchor prefix but different contract_id do NOT cluster', () => {
    const records = [
      rec(
        { graph_node_anchor: 'aaaa1234', intent: 'Add cart item and pay' },
        { contract_id: 'contract-A' },
      ),
      rec(
        { graph_node_anchor: 'aaaa9999', intent: 'Add cart item, then pay' },
        { contract_id: 'contract-B' },
      ),
    ];
    expect(clusterSkills(records, { jaccardThreshold: 0.7, prefixChars: 4 })).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* runMerge — structural merge (no LLM)                               */
/* ------------------------------------------------------------------ */

// Shared contract_id so siblings cluster together.
const SHARED_CONTRACT_ID = 'contract-cart-checkout-v1';

function seedTwoSiblingsOnDisk(rootDir: string): void {
  let now = FIXED_NOW;
  for (const [anchor, intent] of [
    ['aaaaffff0001', 'Add cart item and pay'],
    ['aaaaffff0002', 'Add cart item, then pay'],
  ] as const) {
    for (let i = 0; i < 4; i++) {
      // 4 successful runs ⇒ promoted (threshold 3)
      recordSuccessfulRun(
        {
          txn_id: `t-${anchor}-${i}`,
          contract_id: SHARED_CONTRACT_ID,
          intent,
          domain: 'amazon.com',
          graph_node_anchor: anchor,
        },
        { rootDir, now: () => now++ },
      );
    }
  }
}

describe('runMerge', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('happy path: cluster merges into umbrella, non-seed siblings archived', () => {
    seedTwoSiblingsOnDisk(root);
    const out = runMerge({
      rootDir: root,
      domain: 'amazon.com',
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });
    expect(out.actions.find((a) => a.kind === 'merge')).toBeDefined();
    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
    // Only the non-seed sibling gets an archive entry.
    const archiveDir = path.join(root, 'amazon.com', '.archive');
    expect(fs.readdirSync(archiveDir).length).toBe(1);
  });

  test('umbrella inherits seed name and intent', () => {
    seedTwoSiblingsOnDisk(root);
    const preList = listSkillsForDomain('amazon.com', { rootDir: root });
    const seedBefore = [...preList].sort(
      (a, b) => b.frontmatter.verified_runs - a.frontmatter.verified_runs,
    )[0];

    runMerge({
      rootDir: root,
      domain: 'amazon.com',
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });

    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.name).toBe(seedBefore.frontmatter.name);
    expect(list[0].frontmatter.intent).toBe(seedBefore.frontmatter.intent);
  });

  test('archive reason.json carries merged_into_skill_id', () => {
    seedTwoSiblingsOnDisk(root);
    const out = runMerge({
      rootDir: root,
      domain: 'amazon.com',
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });
    const mergedId = out.actions.find((a) => a.kind === 'merge')!.skill_id;
    const archiveDir = path.join(root, 'amazon.com', '.archive');
    for (const sub of fs.readdirSync(archiveDir)) {
      const reason = JSON.parse(
        fs.readFileSync(path.join(archiveDir, sub, 'reason.json'), 'utf8'),
      );
      expect(reason.reason).toBe('merged_into');
      expect(reason.merged_into_skill_id).toBe(mergedId);
    }
  });

  test('umbrella SKILL.md frontmatter has aggregate verified_runs', () => {
    seedTwoSiblingsOnDisk(root);
    runMerge({
      rootDir: root,
      domain: 'amazon.com',
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });
    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
    const text = fs.readFileSync(list[0].filePath, 'utf8');
    const parsed = parseSkillMd(text);
    expect(parsed.frontmatter.verified_runs).toBe(8); // 4 + 4
  });

  test('does nothing when no clusters exist', () => {
    let now = FIXED_NOW;
    recordSuccessfulRun(
      {
        txn_id: 't1',
        contract_id: 'A',
        intent: 'lone skill',
        domain: 'amazon.com',
        graph_node_anchor: 'aaaa1111',
      },
      { rootDir: root, now: () => now++ },
    );
    const out = runMerge({
      rootDir: root,
      domain: 'amazon.com',
      jaccardThreshold: 0.7,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });
    expect(out.actions).toHaveLength(0);
    expect(out.errors).toHaveLength(0);
  });

  test('umbrella filename equals computeSkillId(seed.graph_node_anchor, seed.contract_id)', () => {
    seedTwoSiblingsOnDisk(root);
    const preList = listSkillsForDomain('amazon.com', { rootDir: root });
    const expectedIds = preList.map((r) =>
      computeSkillId(r.frontmatter.graph_node_anchor, r.sidecar.contract_id),
    );

    runMerge({
      rootDir: root,
      domain: 'amazon.com',
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });

    const postList = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(postList).toHaveLength(1);
    const umbrellaSkillId = postList[0].skill_id;
    expect(expectedIds).toContain(umbrellaSkillId);

    const sidecar = postList[0].sidecar;
    expect(computeSkillId(sidecar.graph_node_anchor, sidecar.contract_id)).toBe(umbrellaSkillId);
  });

  test('merged umbrella runs.recent carries sibling histories sorted oldest-first', () => {
    const SIBLING_RUNS = 5;
    const anchors = ['aaaaffff0001', 'aaaaffff0002'] as const;
    let tick = FIXED_NOW;

    for (const anchor of anchors) {
      for (let i = 0; i < SIBLING_RUNS; i++) {
        recordSuccessfulRun(
          {
            txn_id: `reg-${anchor}-${i}`,
            contract_id: SHARED_CONTRACT_ID,
            intent: 'Add cart item and pay',
            domain: 'amazon.com',
            graph_node_anchor: anchor,
          },
          { rootDir: root, now: () => tick++ },
        );
      }
    }

    runMerge({
      rootDir: root,
      domain: 'amazon.com',
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => tick,
    });

    const postList = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(postList).toHaveLength(1);
    const umbrella = postList[0];
    const recent = umbrella.sidecar.runs.recent;

    const totalSiblingRuns = anchors.length * SIBLING_RUNS; // 10, under cap
    expect(recent.length).toBe(Math.min(totalSiblingRuns, SKILL_RUN_LOG_MAX));

    // Oldest-first sort.
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i - 1].ts).toBeLessThanOrEqual(recent[i].ts);
    }
  });

  test('follow-up recordSuccessfulRun does not regress verified_runs below merged aggregate', () => {
    const SIBLING_RUNS = 5;
    const anchors = ['aaaaffff0001', 'aaaaffff0002'] as const;
    let tick = FIXED_NOW;

    for (const anchor of anchors) {
      for (let i = 0; i < SIBLING_RUNS; i++) {
        recordSuccessfulRun(
          {
            txn_id: `reg-${anchor}-${i}`,
            contract_id: SHARED_CONTRACT_ID,
            intent: 'Add cart item and pay',
            domain: 'amazon.com',
            graph_node_anchor: anchor,
          },
          { rootDir: root, now: () => tick++ },
        );
      }
    }

    runMerge({
      rootDir: root,
      domain: 'amazon.com',
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => tick,
    });

    const umbrella = listSkillsForDomain('amazon.com', { rootDir: root })[0];
    const mergedVerifiedRuns = umbrella.frontmatter.verified_runs;
    const followUpResult = recordSuccessfulRun(
      {
        txn_id: 'follow-up-txn',
        contract_id: SHARED_CONTRACT_ID,
        intent: 'Add cart item and pay',
        domain: 'amazon.com',
        graph_node_anchor: umbrella.frontmatter.graph_node_anchor,
      },
      { rootDir: root, now: () => tick + 1000 },
    );
    expect(followUpResult.record.frontmatter.verified_runs).toBeGreaterThanOrEqual(mergedVerifiedRuns);
  });

  test('overflow after merge: runs.recent capped at SKILL_RUN_LOG_MAX, oldest dropped', () => {
    const anchors = ['bbbbffff0001', 'bbbbffff0002'] as const;
    let tick = FIXED_NOW - 100_000;

    for (const anchor of anchors) {
      for (let i = 0; i < SKILL_RUN_LOG_MAX; i++) {
        recordSuccessfulRun(
          {
            txn_id: `overflow-${anchor}-${i}`,
            contract_id: SHARED_CONTRACT_ID,
            intent: 'Add cart item and pay',
            domain: 'amazon.com',
            graph_node_anchor: anchor,
          },
          { rootDir: root, now: () => tick++ },
        );
      }
    }

    const oldestTs = FIXED_NOW - 100_000;

    runMerge({
      rootDir: root,
      domain: 'amazon.com',
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => tick,
    });

    const postList = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(postList).toHaveLength(1);
    const recentAfterMerge = postList[0].sidecar.runs.recent;

    // Capped.
    expect(recentAfterMerge.length).toBe(SKILL_RUN_LOG_MAX);

    // Oldest-first.
    for (let i = 1; i < recentAfterMerge.length; i++) {
      expect(recentAfterMerge[i - 1].ts).toBeLessThanOrEqual(recentAfterMerge[i].ts);
    }

    // Oldest pre-merge entry dropped.
    expect(recentAfterMerge.some((r) => r.ts === oldestTs)).toBe(false);

    // Follow-up run: newest must survive, cap preserved.
    const newRunTs = tick + 9_999_999;
    const followUpResult = recordSuccessfulRun(
      {
        txn_id: 'overflow-follow-up',
        contract_id: SHARED_CONTRACT_ID,
        intent: 'Add cart item and pay',
        domain: 'amazon.com',
        graph_node_anchor: postList[0].frontmatter.graph_node_anchor,
      },
      { rootDir: root, now: () => newRunTs },
    );

    const recentAfterFollowUp = followUpResult.record.sidecar.runs.recent;
    expect(recentAfterFollowUp.length).toBe(SKILL_RUN_LOG_MAX);
    expect(recentAfterFollowUp.some((r) => r.ts === newRunTs)).toBe(true);
    expect(followUpResult.record.frontmatter.verified_runs).toBe(SKILL_RUN_LOG_MAX);
  });

  test('umbrella adopts freshest sibling last_verified_at + contract_ref', () => {
    const STALE_TS = '2026-01-01T00:00:00Z';
    const FRESH_TS = '2026-04-30T00:00:00Z';
    const STALE_CONTRACT = 'txn-stale-aaa';
    const FRESH_CONTRACT = 'txn-fresh-bbb';

    const anchors = ['ccccffff0001', 'ccccffff0002'] as const;
    let tick = FIXED_NOW;
    for (const anchor of anchors) {
      for (let i = 0; i < 4; i++) {
        recordSuccessfulRun(
          {
            txn_id: `prov-${anchor}-${i}`,
            contract_id: SHARED_CONTRACT_ID,
            intent: 'Add cart item and pay',
            domain: 'amazon.com',
            graph_node_anchor: anchor,
          },
          { rootDir: root, now: () => tick++ },
        );
      }
    }

    // Overwrite frontmatter of both siblings with controlled provenance.
    const skills = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(skills).toHaveLength(2);
    const [sibA, sibB] = skills;
    for (const [sib, lva, cref] of [
      [sibA, STALE_TS, STALE_CONTRACT],
      [sibB, FRESH_TS, FRESH_CONTRACT],
    ] as const) {
      const text = fs.readFileSync(sib.filePath, 'utf8');
      const patched = text
        .replace(/last_verified_at: .+/, `last_verified_at: ${lva}`)
        .replace(/contract_ref: .+/, `contract_ref: ${cref}`);
      fs.writeFileSync(sib.filePath, patched);
    }

    const CURATOR_TS = FIXED_NOW + 99_999;
    runMerge({
      rootDir: root,
      domain: 'amazon.com',
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => CURATOR_TS,
    });

    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
    const parsed = parseSkillMd(fs.readFileSync(list[0].filePath, 'utf8'));

    expect(parsed.frontmatter.last_verified_at).toBe(FRESH_TS);
    expect(parsed.frontmatter.contract_ref).toBe(FRESH_CONTRACT);

    const curatorIso = new Date(CURATOR_TS).toISOString();
    expect(parsed.frontmatter.last_verified_at).not.toBe(curatorIso);
  });

  test('idempotent: re-running on already-merged state produces no actions', () => {
    seedTwoSiblingsOnDisk(root);
    runMerge({
      rootDir: root,
      domain: 'amazon.com',
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });
    // Only one skill left — clusterSkills finds no cluster.
    const out2 = runMerge({
      rootDir: root,
      domain: 'amazon.com',
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW + 1,
    });
    expect(out2.actions).toHaveLength(0);
    expect(out2.errors).toHaveLength(0);
  });

  test('no LLM dependency: runMerge is synchronous and returns MergeOutcome directly', () => {
    // Verify the return is not a Promise — structural-only path is sync.
    seedTwoSiblingsOnDisk(root);
    const result = runMerge({
      rootDir: root,
      domain: 'amazon.com',
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });
    // If it were a Promise, it would not have an `actions` array directly.
    expect(Array.isArray(result.actions)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });
});
