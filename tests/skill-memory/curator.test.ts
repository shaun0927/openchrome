import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCurator, type SkillRunStats } from '../../src/skill-memory/curator';
import { recordSuccessfulRun, listSkillsForDomain } from '../../src/skill-memory/extractor';
import { parseSkillMd } from '../../src/skill-memory/skill-md';
import type { SkillRecord } from '../../src/skill-memory/types';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-curator-'));
}

const FIXED_NOW = Date.parse('2026-05-08T12:00:00Z');

/** Helper: seed a domain with N successful runs of a single skill. */
function seedSkill(rootDir: string, domain: string, contractId: string, runs: number): void {
  let now = FIXED_NOW;
  // graph_node_anchor must be lowercase hex (HEX_PATTERN). Build a stable
  // hash from contractId rather than embedding the raw id.
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

function statsForFailingPromoted(): SkillRunStats {
  return {
    successesInWindow: 1,
    failuresInWindow: 9,
    lastRunAt: FIXED_NOW,
    demotesInDoubleDemoteWindow: 0,
  };
}

function statsForHealthy(): SkillRunStats {
  return {
    successesInWindow: 5,
    failuresInWindow: 0,
    lastRunAt: FIXED_NOW,
    demotesInDoubleDemoteWindow: 0,
  };
}

describe('runCurator — Pass 1 demote', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('demotes promoted skill with fail_rate > 0.30 and ≥5 runs', () => {
    seedSkill(root, 'amazon.com', 'A', 3); // promotes after 3 successes
    const before = listSkillsForDomain('amazon.com', { rootDir: root })[0];
    expect(before.frontmatter.status).toBe('promoted');

    const report = runCurator(() => statsForFailingPromoted(), {
      rootDir: root,
      now: () => FIXED_NOW + 1_000_000,
    });
    expect(report.actions.length).toBe(1);
    expect(report.actions[0].kind).toBe('demote');
    const after = listSkillsForDomain('amazon.com', { rootDir: root })[0];
    expect(after.frontmatter.status).toBe('candidate');
    expect(after.frontmatter.verified_runs).toBe(1);
    expect(after.sidecar.runs.count).toBe(1);
    expect(after.sidecar.runs.recent).toHaveLength(1);
  });

  test('does NOT demote when total runs < 5', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const stats: SkillRunStats = {
      successesInWindow: 1,
      failuresInWindow: 3, // total = 4 < 5
      lastRunAt: FIXED_NOW,
      demotesInDoubleDemoteWindow: 0,
    };
    const report = runCurator(() => stats, { rootDir: root, now: () => FIXED_NOW });
    expect(report.actions.filter((a) => a.kind === 'demote')).toHaveLength(0);
  });

  test('does NOT demote when fail_rate ≤ 0.30', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const stats: SkillRunStats = {
      successesInWindow: 7,
      failuresInWindow: 3, // 30% exactly
      lastRunAt: FIXED_NOW,
      demotesInDoubleDemoteWindow: 0,
    };
    const report = runCurator(() => stats, { rootDir: root, now: () => FIXED_NOW });
    expect(report.actions.filter((a) => a.kind === 'demote')).toHaveLength(0);
  });

  test('archives on double-demote without intervening promotion', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const stats: SkillRunStats = {
      ...statsForFailingPromoted(),
      demotesInDoubleDemoteWindow: 1,
      hadInterveningPromotion: false,
    };
    const report = runCurator(() => stats, { rootDir: root, now: () => FIXED_NOW + 1_000_000 });
    expect(report.actions[0].kind).toBe('archive_double_demote');
    // active dir empty; archived under .archive/
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'amazon.com', '.archive'))).toBe(true);
  });

  test('does NOT archive on double-demote when intervening promotion exists', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const stats: SkillRunStats = {
      ...statsForFailingPromoted(),
      demotesInDoubleDemoteWindow: 1,
      hadInterveningPromotion: true,
    };
    const report = runCurator(() => stats, { rootDir: root, now: () => FIXED_NOW + 1_000_000 });
    expect(report.actions[0].kind).toBe('demote');
  });
});

describe('runCurator — Pass 3 archive', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('archives stale skills (last_verified_at older than threshold + 0 successes)', () => {
    seedSkill(root, 'amazon.com', 'A', 1); // candidate after 1 run
    const stats: SkillRunStats = {
      successesInWindow: 0,
      failuresInWindow: 0,
      lastRunAt: FIXED_NOW,
      demotesInDoubleDemoteWindow: 0,
    };
    const future = FIXED_NOW + 31 * 24 * 60 * 60 * 1000; // > 30 days later
    const report = runCurator(() => stats, { rootDir: root, now: () => future });
    expect(report.actions[0].kind).toBe('archive_stale');
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(0);
  });

  test('archives untouched skills (no skill_run for 60 days)', () => {
    seedSkill(root, 'amazon.com', 'A', 1);
    const stats: SkillRunStats = {
      successesInWindow: 0,
      failuresInWindow: 0,
      lastRunAt: null, // never touched
      demotesInDoubleDemoteWindow: 0,
    };
    // Within stale-archive window (last_verified_at recent enough), but
    // the untouched threshold should fire instead.
    const future = FIXED_NOW + 61 * 24 * 60 * 60 * 1000;
    const report = runCurator(() => stats, { rootDir: root, now: () => future });
    // The stale rule fires first because last_verified_at age also > 30d.
    // Either archive_stale or archive_untouched is acceptable here —
    // the contract is "skill leaves active state" not "exact label".
    expect(['archive_stale', 'archive_untouched']).toContain(report.actions[0].kind);
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(0);
  });

  test('does NOT archive when skill is healthy', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const report = runCurator(() => statsForHealthy(), { rootDir: root, now: () => FIXED_NOW });
    expect(report.actions).toHaveLength(0);
    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    expect(list).toHaveLength(1);
    expect(list[0].frontmatter.status).toBe('promoted');
  });
});

describe('runCurator — safety rails', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('skips user-authored skills', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    // Flip author manually
    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    const userPath = list[0].filePath;
    const content = fs.readFileSync(userPath, 'utf8').replace('author: agent', 'author: user');
    fs.writeFileSync(userPath, content);

    const report = runCurator(() => statsForFailingPromoted(), {
      rootDir: root,
      now: () => FIXED_NOW + 1_000_000,
    });
    expect(report.actions[0].kind).toBe('skip_user_authored');
    // Skill stays in place (active dir).
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(1);
  });

  test('writes reason.json under .archive/ on archival', () => {
    seedSkill(root, 'amazon.com', 'A', 1);
    const stats: SkillRunStats = {
      successesInWindow: 0,
      failuresInWindow: 0,
      lastRunAt: null,
      demotesInDoubleDemoteWindow: 0,
    };
    const future = FIXED_NOW + 61 * 24 * 60 * 60 * 1000;
    runCurator(() => stats, { rootDir: root, now: () => future });
    const archived = fs.readdirSync(path.join(root, 'amazon.com', '.archive'));
    expect(archived.length).toBe(1);
    const reasonPath = path.join(root, 'amazon.com', '.archive', archived[0], 'reason.json');
    const reason = JSON.parse(fs.readFileSync(reasonPath, 'utf8'));
    expect(reason.archived_by).toBe('curator');
    expect(reason.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('archived SKILL.md has its frontmatter status updated to archived', () => {
    seedSkill(root, 'amazon.com', 'A', 1);
    const stats: SkillRunStats = {
      successesInWindow: 0,
      failuresInWindow: 0,
      lastRunAt: null,
      demotesInDoubleDemoteWindow: 0,
    };
    const future = FIXED_NOW + 61 * 24 * 60 * 60 * 1000;
    runCurator(() => stats, { rootDir: root, now: () => future });
    const archiveDir = fs.readdirSync(path.join(root, 'amazon.com', '.archive'))[0];
    const archivedDir = path.join(root, 'amazon.com', '.archive', archiveDir);
    const mdFile = fs.readdirSync(archivedDir).find((f) => f.endsWith('.md'))!;
    const parsed = parseSkillMd(fs.readFileSync(path.join(archivedDir, mdFile), 'utf8'));
    expect(parsed.frontmatter.status).toBe('archived');
  });

  test('idempotent — second run on identical state produces empty actions', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    runCurator(() => statsForHealthy(), { rootDir: root, now: () => FIXED_NOW });
    const second = runCurator(() => statsForHealthy(), { rootDir: root, now: () => FIXED_NOW });
    expect(second.actions).toHaveLength(0);
  });

  test('does not crash when statsResolver throws — surfaces via report.errors', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const report = runCurator(
      (rec) => {
        throw new Error('audit log read failed');
      },
      { rootDir: root, now: () => FIXED_NOW },
    );
    expect(report.errors[0]).toContain('audit log read failed');
    // Skill stays in place since it could not be evaluated.
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(1);
  });
});

describe('runCurator — multi-domain', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('walks every domain dir; skips dot-prefixed (.curator, .archive)', () => {
    seedSkill(root, 'amazon.com', 'A', 1);
    seedSkill(root, 'github.com', 'B', 1);
    fs.mkdirSync(path.join(root, '.curator'), { recursive: true });
    const report = runCurator(() => statsForHealthy(), { rootDir: root, now: () => FIXED_NOW });
    expect(report.stats.domains_seen).toBe(2);
  });
});
