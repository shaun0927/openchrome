import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runPromote } from '../../../src/pilot/curator/promote';
import { recordSuccessfulRun, listSkillsForDomain } from '../../../src/pilot/curator/extractor';
import { SkillMemoryStore } from '../../../src/core/skill-memory/store';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-promote-'));
}

const FIXED_NOW = Date.parse('2026-05-08T12:00:00Z');

function seedSkill(rootDir: string, domain: string, contractId: string, runs: number): void {
  let now = FIXED_NOW;
  const anchor = Buffer.from(contractId).toString('hex');
  for (let i = 0; i < runs; i++) {
    recordSuccessfulRun(
      {
        txn_id: `t-${contractId}-${i}`,
        contract_id: contractId,
        intent: `Test ${contractId}`,
        domain,
        graph_node_anchor: anchor,
      },
      { rootDir, now: () => now++ },
    );
  }
}

/**
 * Seed a matching record in the SkillMemoryStore so Pass 3 can find it.
 */
async function seedStore(
  rootDir: string,
  domain: string,
  skillId: string,
  name: string,
  contractId: string,
): Promise<void> {
  const store = new SkillMemoryStore({ rootDir, domain });
  await store.record({
    skillId,
    domain,
    name,
    steps: [],
    contractId,
    successCount: 0,
    lastUsedAt: 0,
    frozenSnapshotPath: null,
  });
}

describe('runPromote — updates store ranking weights', () => {
  let root: string;
  beforeEach(() => { root = tempRoot(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('updates successCount and lastUsedAt when sidecar diverges from store', async () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const skills = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(skills).toHaveLength(1);
    const rec = skills[0];

    await seedStore(root, 'amazon.com', rec.skill_id, rec.frontmatter.name, 'A');

    const report = await runPromote({ rootDir: root, now: () => FIXED_NOW });
    expect(report.errors).toHaveLength(0);
    expect(report.updated).toBe(1);

    const store = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
    const updated = store.get(rec.skill_id);
    // markUsed increments successCount by 1 per call; after one promote cycle
    // the count goes from 0 → 1 (one call with success=true).
    expect(updated?.successCount).toBeGreaterThanOrEqual(1);
  });

  test('skips skills with no store record (skipped_no_record incremented)', async () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    // No store.record() call — skill is unknown to the store.
    const report = await runPromote({ rootDir: root, now: () => FIXED_NOW });
    expect(report.skipped_no_record).toBe(1);
    expect(report.updated).toBe(0);
  });

  test('does not update when successCount and lastUsedAt already match', async () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const skills = listSkillsForDomain('amazon.com', { rootDir: root });
    const rec = skills[0];

    // Pre-populate the store with the exact same values the promote would set.
    const successEntries = rec.sidecar.runs.recent.filter((e) => e.ok);
    const latestTs = Math.max(...successEntries.map((e) => e.ts));
    const store = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
    await store.record({
      skillId: rec.skill_id,
      domain: 'amazon.com',
      name: rec.frontmatter.name,
      steps: [],
      contractId: 'A',
      successCount: rec.sidecar.runs.count,
      lastUsedAt: latestTs,
      frozenSnapshotPath: null,
    });

    const report = await runPromote({ rootDir: root, now: () => FIXED_NOW });
    expect(report.updated).toBe(0);
  });

  test('skips archived skills', async () => {
    seedSkill(root, 'amazon.com', 'A', 1);
    const skills = listSkillsForDomain('amazon.com', { rootDir: root });
    const rec = skills[0];
    // Manually set status to archived.
    const content = fs.readFileSync(rec.filePath, 'utf8').replace('status: candidate', 'status: archived');
    fs.writeFileSync(rec.filePath, content);

    await seedStore(root, 'amazon.com', rec.skill_id, rec.frontmatter.name, 'A');

    const report = await runPromote({ rootDir: root, now: () => FIXED_NOW });
    expect(report.updated).toBe(0);
  });

  test('throws when rootDir is empty string', async () => {
    await expect(runPromote({ rootDir: '' })).rejects.toThrow(/rootDir/);
  });

  test('returns correct stats counts', async () => {
    seedSkill(root, 'amazon.com', 'A', 1);
    seedSkill(root, 'github.com', 'B', 1);
    fs.mkdirSync(path.join(root, '.curator'), { recursive: true });

    const report = await runPromote({ rootDir: root, now: () => FIXED_NOW });
    expect(report.stats.domains_seen).toBe(2);
    expect(report.stats.skills_seen).toBe(2);
    expect(report.run_id).toMatch(/^[0-9a-f]{12}$/);
  });
});
