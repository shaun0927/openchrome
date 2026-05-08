import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  clusterSkills,
  jaccard,
  runPass2Merge,
  tokenize,
  type MergeRequester,
} from '../../src/skill-memory/curator-pass2';
import { computeSkillId, recordSuccessfulRun, listSkillsForDomain } from '../../src/skill-memory/extractor';
import { parseSkillMd } from '../../src/skill-memory/skill-md';
import { SKILL_RUN_LOG_MAX } from '../../src/skill-memory/types';
import type { SkillRecord } from '../../src/skill-memory/types';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cur2-'));
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
    // Regression test for fix #1: contract_id boundary must be enforced
    // before anchor-prefix and Jaccard checks.
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
/* runPass2Merge                                                       */
/* ------------------------------------------------------------------ */

// Shared contract_id so the two siblings cluster together under fix #1.
const SHARED_CONTRACT_ID = 'contract-cart-checkout-v1';

function seedTwoSiblingsOnDisk(rootDir: string): void {
  let now = FIXED_NOW;
  // Same graph_node_anchor (so identity collides) would dedup at the
  // extractor; use distinct anchors with the same prefix instead.
  // Both siblings share SHARED_CONTRACT_ID — required for clustering.
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

describe('runPass2Merge', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('happy path: clusters merge into umbrella, siblings archived', async () => {
    seedTwoSiblingsOnDisk(root);
    const requester: MergeRequester = async () => ({
      ok: true,
      name: 'amazon.cart-add',
      intent: 'Add cart item and complete checkout (umbrella)',
      body: '## Steps\n1. Click add\n2. Click pay\n',
    });
    const out = await runPass2Merge({
      rootDir: root,
      domain: 'amazon.com',
      requester,
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });
    expect(out.actions.find((a) => a.kind === 'merge')).toBeDefined();
    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.name).toBe('amazon.cart-add');
    // The seed sibling's file is overwritten in place with umbrella content
    // (its canonical ID IS the umbrella ID), so only the non-seed sibling
    // gets an archive entry. Total archive entries = cluster.length - 1.
    const archiveDir = path.join(root, 'amazon.com', '.archive');
    expect(fs.readdirSync(archiveDir).length).toBe(1);
  });

  test('archive reason.json carries merged_into_skill_id', async () => {
    seedTwoSiblingsOnDisk(root);
    const out = await runPass2Merge({
      rootDir: root,
      domain: 'amazon.com',
      requester: async () => ({
        ok: true,
        name: 'umbrella',
        intent: 'umbrella intent',
        body: '## Steps\n',
      }),
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

  test('umbrella SKILL.md frontmatter is parseable and has aggregate verified_runs', async () => {
    seedTwoSiblingsOnDisk(root);
    await runPass2Merge({
      rootDir: root,
      domain: 'amazon.com',
      requester: async () => ({
        ok: true,
        name: 'umbrella',
        intent: 'umbrella intent',
        body: '## Steps\nGo do thing\n',
      }),
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });
    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
    const text = fs.readFileSync(list[0].filePath, 'utf8');
    const parsed = parseSkillMd(text);
    expect(parsed.frontmatter.verified_runs).toBe(8); // 4 + 4
    expect(parsed.body).toContain('Go do thing');
  });

  test('requester returns ok:false → cluster skipped, no files moved', async () => {
    seedTwoSiblingsOnDisk(root);
    const out = await runPass2Merge({
      rootDir: root,
      domain: 'amazon.com',
      requester: async () => ({ ok: false, reason: 'not similar enough on closer inspection' }),
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });
    const skipped = out.actions.find((a) => a.kind === 'merge_skipped');
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toContain('not similar');
    // Both originals still in active dir
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(2);
  });

  test('requester throws → cluster skipped + recorded in errors[]', async () => {
    seedTwoSiblingsOnDisk(root);
    const out = await runPass2Merge({
      rootDir: root,
      domain: 'amazon.com',
      requester: async () => {
        throw new Error('LLM provider exploded');
      },
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });
    expect(out.errors[0]).toContain('LLM provider exploded');
    expect(out.actions.find((a) => a.kind === 'merge_skipped')).toBeDefined();
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(2);
  });

  test('requester returns invalid name → merge_skipped (frontmatter validation)', async () => {
    seedTwoSiblingsOnDisk(root);
    const out = await runPass2Merge({
      rootDir: root,
      domain: 'amazon.com',
      requester: async () => ({
        ok: true,
        name: 'INVALID NAME WITH SPACES', // fails NAME_PATTERN
        intent: 'umbrella',
        body: '## Steps\n',
      }),
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });
    expect(out.actions[0].kind).toBe('merge_skipped');
    expect(out.actions[0].reason).toContain('merge_parse_failure');
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(2);
  });

  test('does nothing when no clusters exist', async () => {
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
    const out = await runPass2Merge({
      rootDir: root,
      domain: 'amazon.com',
      requester: async () => ({ ok: true, name: 'umbrella', intent: 'i', body: '' }),
      jaccardThreshold: 0.7,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });
    expect(out.actions).toHaveLength(0);
    expect(out.errors).toHaveLength(0);
  });

  test('merged umbrella runs.recent carries sibling histories and a follow-up recordSuccessfulRun does not regress verified_runs', async () => {
    // Two siblings, each with 5 run events in runs.recent (distinct timestamps).
    // After merge the umbrella's runs.recent must be sorted oldest-first (append
    // order) so that recordSuccessfulRun's [...recent, newRun].slice(-N) drops the
    // OLDEST entry on overflow rather than the newest.
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

    await runPass2Merge({
      rootDir: root,
      domain: 'amazon.com',
      requester: async () => ({
        ok: true,
        name: 'amazon.cart-add-reg',
        intent: 'Add cart item and pay (umbrella)',
        body: '## Steps\n1. Add\n2. Pay\n',
      }),
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => tick,
    });

    const postList = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(postList).toHaveLength(1);
    const umbrella = postList[0];
    const recent = umbrella.sidecar.runs.recent;

    // recent must contain entries from both siblings (up to the cap)
    const totalSiblingRuns = anchors.length * SIBLING_RUNS; // 10, well under cap of 50
    expect(recent.length).toBe(Math.min(totalSiblingRuns, SKILL_RUN_LOG_MAX));

    // entries must be sorted oldest-first (append order) so slice(-N) on overflow
    // drops the oldest entries, not the newest
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i - 1].ts).toBeLessThanOrEqual(recent[i].ts);
    }

    // A follow-up successful run must NOT reduce verified_runs below the merged aggregate
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

  test('overflow after merge drops oldest entry, not newest', async () => {
    // Fill both siblings' runs.recent to capacity (SKILL_RUN_LOG_MAX = 50 entries
    // each, with old timestamps) so the merged array exceeds the cap. After merge
    // runs.recent must still be capped at SKILL_RUN_LOG_MAX and contain the NEWEST
    // entries (oldest dropped). Then simulate a recordSuccessfulRun overflow: the
    // new run's ts must survive and the oldest pre-merge ts must be gone.
    const anchors = ['bbbbffff0001', 'bbbbffff0002'] as const;
    // Use timestamps well in the past so they are clearly "older" than follow-up
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

    // Record the very first (oldest) timestamp across all sibling entries
    const oldestTs = FIXED_NOW - 100_000;

    await runPass2Merge({
      rootDir: root,
      domain: 'amazon.com',
      requester: async () => ({
        ok: true,
        name: 'amazon.cart-add-overflow',
        intent: 'Add cart item and pay (umbrella)',
        body: '## Steps\n1. Add\n2. Pay\n',
      }),
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => tick,
    });

    const postList = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(postList).toHaveLength(1);
    const umbrella = postList[0];
    const recentAfterMerge = umbrella.sidecar.runs.recent;

    // Capped at SKILL_RUN_LOG_MAX
    expect(recentAfterMerge.length).toBe(SKILL_RUN_LOG_MAX);

    // Oldest-first order preserved after merge cap
    for (let i = 1; i < recentAfterMerge.length; i++) {
      expect(recentAfterMerge[i - 1].ts).toBeLessThanOrEqual(recentAfterMerge[i].ts);
    }

    // The oldest pre-merge entry must have been dropped (not present)
    expect(recentAfterMerge.some((r) => r.ts === oldestTs)).toBe(false);

    // Now simulate a follow-up recordSuccessfulRun that causes another overflow.
    // recordSuccessfulRun recomputes verified_runs from runs.recent (not from the
    // aggregate frontmatter), so after the overflow it will reflect the capped
    // window count — but crucially the newest entry must survive and the oldest
    // must be evicted (not the newest).
    const newRunTs = tick + 9_999_999; // far in the future — definitely the newest
    const followUpResult = recordSuccessfulRun(
      {
        txn_id: 'overflow-follow-up',
        contract_id: SHARED_CONTRACT_ID,
        intent: 'Add cart item and pay',
        domain: 'amazon.com',
        graph_node_anchor: umbrella.frontmatter.graph_node_anchor,
      },
      { rootDir: root, now: () => newRunTs },
    );

    const recentAfterFollowUp = followUpResult.record.sidecar.runs.recent;
    // Still capped
    expect(recentAfterFollowUp.length).toBe(SKILL_RUN_LOG_MAX);
    // The NEW run must be present — oldest-first sort ensures slice(-N) kept it
    expect(recentAfterFollowUp.some((r) => r.ts === newRunTs)).toBe(true);
    // verified_runs reflects the capped window (all entries are ok=true successes)
    expect(followUpResult.record.frontmatter.verified_runs).toBe(SKILL_RUN_LOG_MAX);
  });

  test('umbrella adopts freshest sibling last_verified_at + paired contract_ref, not curator runtime ts', async () => {
    // Arrange: two siblings with distinct last_verified_at and contract_ref values.
    // The "stale" sibling was verified long ago; the "fresh" sibling was verified recently.
    const STALE_TS = '2026-01-01T00:00:00Z';
    const FRESH_TS = '2026-04-30T00:00:00Z';
    const STALE_CONTRACT = 'txn-stale-aaa';
    const FRESH_CONTRACT = 'txn-fresh-bbb';

    // Write two siblings directly onto disk with controlled frontmatter.
    // We need 4 runs each (≥ promoted threshold) so merge is attempted.
    // Use distinct anchors with a shared 4-char prefix and SHARED_CONTRACT_ID
    // so they cluster together.
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

    // Now overwrite the frontmatter of the two siblings to set controlled
    // last_verified_at / contract_ref values for the provenance test.
    const skills = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(skills).toHaveLength(2);
    const [sibA, sibB] = skills;
    // Overwrite each sibling's .md with patched frontmatter.
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

    // Act: merge
    const CURATOR_TS = FIXED_NOW + 99_999; // distinct from both sibling timestamps
    await runPass2Merge({
      rootDir: root,
      domain: 'amazon.com',
      requester: async () => ({
        ok: true,
        name: 'amazon.cart-add-prov',
        intent: 'Add cart item and pay (umbrella)',
        body: '## Steps\n1. Add\n2. Pay\n',
      }),
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => CURATOR_TS,
    });

    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
    const parsed = parseSkillMd(fs.readFileSync(list[0].filePath, 'utf8'));

    // Assert: umbrella carries the FRESH sibling's provenance pair.
    expect(parsed.frontmatter.last_verified_at).toBe(FRESH_TS);
    expect(parsed.frontmatter.contract_ref).toBe(FRESH_CONTRACT);

    // Negative: must NOT equal the synthetic curator runtime timestamp.
    const curatorIso = new Date(CURATOR_TS).toISOString();
    expect(parsed.frontmatter.last_verified_at).not.toBe(curatorIso);
  });

  test('umbrella filename equals computeSkillId(seed.graph_node_anchor, seed.contract_id) so recordSuccessfulRun finds it', async () => {
    // Regression: previously umbrellaSkillId() produced a synthetic hash from
    // sibling skill_ids, which recordSuccessfulRun (keyed on
    // (graph_node_anchor, contract_id)) would never match — duplicates reappear.
    seedTwoSiblingsOnDisk(root);

    // Capture the seed before merging (highest verified_runs wins; both are equal
    // here so the first anchor alphabetically wins via stable sort — just grab it
    // from the list before merge).
    const preList = listSkillsForDomain('amazon.com', { rootDir: root });
    // clusterSkills picks seed = highest verified_runs; both have 4, so pick
    // whichever is first in the sorted order — mirror the same tie-break by
    // computing the expected id for each anchor and checking one matches.
    const expectedIds = preList.map((r) =>
      computeSkillId(r.frontmatter.graph_node_anchor, r.sidecar.contract_id),
    );

    await runPass2Merge({
      rootDir: root,
      domain: 'amazon.com',
      requester: async () => ({
        ok: true,
        name: 'amazon.cart-add-umbrella',
        intent: 'Add cart item and complete checkout (umbrella)',
        body: '## Steps\n1. Click add\n2. Click pay\n',
      }),
      jaccardThreshold: 0.5,
      prefixChars: 4,
      now: () => FIXED_NOW,
    });

    const postList = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(postList).toHaveLength(1);

    const umbrellaSkillId = postList[0].skill_id;
    // The umbrella's skill_id must equal computeSkillId for the seed's identity
    // so that a subsequent recordSuccessfulRun call for that anchor+contract pair
    // increments the umbrella rather than creating a fresh duplicate.
    expect(expectedIds).toContain(umbrellaSkillId);

    // Confirm the sidecar records the same canonical fields.
    const sidecar = postList[0].sidecar;
    expect(computeSkillId(sidecar.graph_node_anchor, sidecar.contract_id)).toBe(umbrellaSkillId);
  });
});
