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
