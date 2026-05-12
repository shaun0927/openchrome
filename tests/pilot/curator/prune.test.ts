import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runPrune, type SkillRunStats } from '../../../src/pilot/curator/prune';
import { recordSuccessfulRun, listSkillsForDomain } from '../../../src/pilot/curator/extractor';
import { parseSkillMd } from '../../../src/pilot/curator/skill-md';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-prune-'));
}

const FIXED_NOW = Date.parse('2026-05-08T12:00:00Z');

/**
 * Seed a domain with N successful runs of a single skill.
 * After 3 runs the skill reaches 'promoted' status.
 */
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

function statsForFailingPromoted(): SkillRunStats {
  return {
    successesInWindow: 1,
    failuresInWindow: 9, // fail_rate = 0.90
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

// ---------------------------------------------------------------------------
// Pass 1A — confidence floor
// ---------------------------------------------------------------------------

describe('runPrune — demote', () => {
  let root: string;
  beforeEach(() => { root = tempRoot(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('demotes promoted skill with fail_rate > 0.30 and >= 5 runs', () => {
    seedSkill(root, 'amazon.com', 'A', 3); // promoted after 3 successes
    const before = listSkillsForDomain('amazon.com', { rootDir: root })[0];
    expect(before.frontmatter.status).toBe('promoted');

    const report = runPrune(() => statsForFailingPromoted(), {
      rootDir: root,
      now: () => FIXED_NOW + 1_000_000,
    });
    expect(report.actions).toHaveLength(1);
    expect(report.actions[0].kind).toBe('demote');

    const after = listSkillsForDomain('amazon.com', { rootDir: root })[0];
    expect(after.frontmatter.status).toBe('candidate');
    expect(after.frontmatter.verified_runs).toBe(1);
    expect(after.sidecar.runs.count).toBe(1);
    expect(after.sidecar.runs.recent).toHaveLength(1);
  });

  test('does NOT demote when total runs < failRateMinRuns (5)', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const stats: SkillRunStats = {
      successesInWindow: 1,
      failuresInWindow: 3, // total = 4, below min
      lastRunAt: FIXED_NOW,
      demotesInDoubleDemoteWindow: 0,
    };
    const report = runPrune(() => stats, { rootDir: root, now: () => FIXED_NOW });
    expect(report.actions.filter((a) => a.kind === 'demote')).toHaveLength(0);
  });

  test('does NOT demote when fail_rate <= 0.30 (boundary)', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const stats: SkillRunStats = {
      successesInWindow: 7,
      failuresInWindow: 3, // exactly 30%
      lastRunAt: FIXED_NOW,
      demotesInDoubleDemoteWindow: 0,
    };
    const report = runPrune(() => stats, { rootDir: root, now: () => FIXED_NOW });
    expect(report.actions.filter((a) => a.kind === 'demote')).toHaveLength(0);
  });

  test('archives on double-demote without intervening promotion', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const stats: SkillRunStats = {
      ...statsForFailingPromoted(),
      demotesInDoubleDemoteWindow: 1,
      hadInterveningPromotion: false,
    };
    const report = runPrune(() => stats, { rootDir: root, now: () => FIXED_NOW + 1_000_000 });
    expect(report.actions[0].kind).toBe('archive_double_demote');
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'amazon.com', '.archive'))).toBe(true);
  });

  test('does NOT archive on double-demote when hadInterveningPromotion is true', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const stats: SkillRunStats = {
      ...statsForFailingPromoted(),
      demotesInDoubleDemoteWindow: 1,
      hadInterveningPromotion: true,
    };
    const report = runPrune(() => stats, { rootDir: root, now: () => FIXED_NOW + 1_000_000 });
    expect(report.actions[0].kind).toBe('demote');
  });
});

// ---------------------------------------------------------------------------
// Pass 1B — TTL archival
// ---------------------------------------------------------------------------

describe('runPrune — TTL archive', () => {
  let root: string;
  beforeEach(() => { root = tempRoot(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('archives stale skill (last_verified_at > staleArchiveMs + 0 successes)', () => {
    seedSkill(root, 'amazon.com', 'A', 1);
    const stats: SkillRunStats = {
      successesInWindow: 0,
      failuresInWindow: 0,
      lastRunAt: FIXED_NOW,
      demotesInDoubleDemoteWindow: 0,
    };
    const future = FIXED_NOW + 31 * 24 * 60 * 60 * 1_000;
    const report = runPrune(() => stats, { rootDir: root, now: () => future });
    expect(report.actions[0].kind).toBe('archive_stale');
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(0);
  });

  test('archives untouched skill (no skill_run for > untouchedArchiveMs)', () => {
    seedSkill(root, 'amazon.com', 'A', 1);
    const stats: SkillRunStats = {
      successesInWindow: 0,
      failuresInWindow: 0,
      lastRunAt: null,
      demotesInDoubleDemoteWindow: 0,
    };
    const future = FIXED_NOW + 61 * 24 * 60 * 60 * 1_000;
    const report = runPrune(() => stats, { rootDir: root, now: () => future });
    expect(['archive_stale', 'archive_untouched']).toContain(report.actions[0].kind);
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(0);
  });

  test('does NOT archive when skill is healthy', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const report = runPrune(() => statsForHealthy(), { rootDir: root, now: () => FIXED_NOW });
    expect(report.actions).toHaveLength(0);
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Safety rails
// ---------------------------------------------------------------------------

describe('runPrune — safety rails', () => {
  let root: string;
  beforeEach(() => { root = tempRoot(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('skips user-authored skills', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const list = listSkillsForDomain('amazon.com', { rootDir: root });
    const content = fs.readFileSync(list[0].filePath, 'utf8').replace('author: agent', 'author: user');
    fs.writeFileSync(list[0].filePath, content);

    const report = runPrune(() => statsForFailingPromoted(), {
      rootDir: root,
      now: () => FIXED_NOW + 1_000_000,
    });
    expect(report.actions[0].kind).toBe('skip_user_authored');
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
    const future = FIXED_NOW + 61 * 24 * 60 * 60 * 1_000;
    runPrune(() => stats, { rootDir: root, now: () => future });

    const archived = fs.readdirSync(path.join(root, 'amazon.com', '.archive'));
    expect(archived).toHaveLength(1);
    const reasonPath = path.join(root, 'amazon.com', '.archive', archived[0], 'reason.json');
    const reason = JSON.parse(fs.readFileSync(reasonPath, 'utf8'));
    expect(reason.archived_by).toBe('curator');
    expect(reason.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('archived SKILL.md has frontmatter status updated to archived', () => {
    seedSkill(root, 'amazon.com', 'A', 1);
    const stats: SkillRunStats = {
      successesInWindow: 0,
      failuresInWindow: 0,
      lastRunAt: null,
      demotesInDoubleDemoteWindow: 0,
    };
    const future = FIXED_NOW + 61 * 24 * 60 * 60 * 1_000;
    runPrune(() => stats, { rootDir: root, now: () => future });

    const archiveDir = fs.readdirSync(path.join(root, 'amazon.com', '.archive'))[0];
    const archivedPath = path.join(root, 'amazon.com', '.archive', archiveDir);
    const mdFile = fs.readdirSync(archivedPath).find((f) => f.endsWith('.md'))!;
    const parsed = parseSkillMd(fs.readFileSync(path.join(archivedPath, mdFile), 'utf8'));
    expect(parsed.frontmatter.status).toBe('archived');
  });

  test('idempotent — second run on same state produces empty action list', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    runPrune(() => statsForHealthy(), { rootDir: root, now: () => FIXED_NOW });
    const second = runPrune(() => statsForHealthy(), { rootDir: root, now: () => FIXED_NOW });
    expect(second.actions).toHaveLength(0);
  });

  test('surfaces statsResolver errors in report.errors without crashing', () => {
    seedSkill(root, 'amazon.com', 'A', 3);
    const report = runPrune(
      () => { throw new Error('audit log unavailable'); },
      { rootDir: root, now: () => FIXED_NOW },
    );
    expect(report.errors[0]).toContain('audit log unavailable');
    expect(listSkillsForDomain('amazon.com', { rootDir: root })).toHaveLength(1);
  });

  test('throws when rootDir is empty string', () => {
    expect(() => runPrune(() => statsForHealthy(), { rootDir: '' })).toThrow(/rootDir/);
  });
});

// ---------------------------------------------------------------------------
// Multi-domain
// ---------------------------------------------------------------------------

describe('runPrune — multi-domain', () => {
  let root: string;
  beforeEach(() => { root = tempRoot(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('walks every domain dir and skips dot-prefixed dirs', () => {
    seedSkill(root, 'amazon.com', 'A', 1);
    seedSkill(root, 'github.com', 'B', 1);
    fs.mkdirSync(path.join(root, '.curator'), { recursive: true });
    const report = runPrune(() => statsForHealthy(), { rootDir: root, now: () => FIXED_NOW });
    expect(report.stats.domains_seen).toBe(2);
  });

  test('report run_id is a 12-char hex string', () => {
    const report = runPrune(() => statsForHealthy(), { rootDir: root, now: () => FIXED_NOW });
    expect(report.run_id).toMatch(/^[0-9a-f]{12}$/);
  });
});
