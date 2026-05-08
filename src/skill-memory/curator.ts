/**
 * Skill curator — Pass 1 (demote on contract verdict) + Pass 3
 * (archive stale / untouched). Pass 2 (sibling merge via LLM) lands
 * in PR-23 once the demote/archive substrate is stable.
 *
 * Per #715 v2:
 *
 *   Pass 1 — Demote
 *     fail_rate = postcondition_violations / total_runs (over a 30d window)
 *     when fail_rate > 0.30 AND total_runs ≥ 5 ⇒ candidate, reset
 *       verified_runs to 1
 *     when demoted twice within 60d WITHOUT an intervening promotion ⇒
 *       archive
 *
 *   Pass 3 — Archive
 *     `last_verified_at` older than 30d AND no successful run in window ⇒
 *       archive
 *     Untouched (no `skill_run` audit event) for 60d ⇒ archive even if
 *       not actively failing
 *
 * Stats come from a host-supplied resolver (`SkillStatsResolver`). The
 * curator does not parse the audit log directly — keeps this module
 * pure and testable. The audit-log scanner adapter rides a follow-up.
 *
 * Safety rails (#715 v2): never deletes — only moves to `.archive/`
 * with a `reason.json`. Only touches skills authored by the agent
 * (`author === 'agent'`). Idempotent; rerunning on identical state
 * produces an empty action list.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { listSkillsForDomain } from './extractor';
import { parseSkillMd, stringifySkillMd } from './skill-md';
import type { SkillRecord, SkillStatus } from './types';

export type CuratorActionKind =
  | 'demote'
  | 'archive_stale'
  | 'archive_untouched'
  | 'archive_double_demote'
  | 'skip_user_authored'
  | 'skip_unknown_schema';

export interface CuratorAction {
  kind: CuratorActionKind;
  skill_id: string;
  domain: string;
  reason: string;
  timestamp: number;
}

export interface CuratorReport {
  run_id: string;
  started_at: number;
  ended_at: number;
  actions: CuratorAction[];
  errors: string[];
  stats: {
    domains_seen: number;
    skills_seen: number;
    actions_count: number;
  };
}

/** Per-skill stats the host resolves from its audit log. */
export interface SkillRunStats {
  /** Successful contract runs (verdict === 'success') in the window. */
  successesInWindow: number;
  /** Failed contract runs (postcondition_violation) in the window. */
  failuresInWindow: number;
  /** ms epoch of the most recent skill_run audit event (regardless of outcome). */
  lastRunAt: number | null;
  /** Demote events for this skill in the past `doubleDemoteWindowMs`. */
  demotesInDoubleDemoteWindow: number;
  /** True iff the last status transition was a promote (resets the demote counter). */
  hadInterveningPromotion?: boolean;
}

export type SkillStatsResolver = (record: SkillRecord, windowMs?: number) => SkillRunStats;

export interface CuratorOptions {
  rootDir?: string;
  /** Pass 1: fail-rate cutoff. Default 0.30 (30%). */
  failRateThreshold?: number;
  /** Pass 1: minimum total runs to consider. Default 5. */
  failRateMinRuns?: number;
  /** Pass 1: window for fail-rate measurement. Default 30 days. */
  failWindowMs?: number;
  /** Pass 1: window for double-demote detection. Default 60 days. */
  doubleDemoteWindowMs?: number;
  /** Pass 3: archive `last_verified_at` older than this. Default 30 days. */
  staleArchiveMs?: number;
  /** Pass 3: archive untouched (no skill_run) for this long. Default 60 days. */
  untouchedArchiveMs?: number;
  /** Test hook: clock. */
  now?: () => number;
}

const DEFAULTS = {
  failRateThreshold: 0.3,
  failRateMinRuns: 5,
  failWindowMs: 30 * 24 * 60 * 60 * 1000,
  doubleDemoteWindowMs: 60 * 24 * 60 * 60 * 1000,
  staleArchiveMs: 30 * 24 * 60 * 60 * 1000,
  untouchedArchiveMs: 60 * 24 * 60 * 60 * 1000,
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function listDomains(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue; // skip .curator, .archive
    out.push(entry.name);
  }
  return out;
}

interface MutationContext {
  rootDir: string;
  domain: string;
  record: SkillRecord;
  ts: number;
}

function archiveSkill(
  ctx: MutationContext,
  reason: CuratorActionKind,
  detail: string,
): void {
  const archiveDir = path.join(ctx.rootDir, ctx.domain, '.archive', ctx.record.skill_id);
  fs.mkdirSync(archiveDir, { recursive: true });
  const newMdPath = path.join(archiveDir, path.basename(ctx.record.filePath));
  const newSidecarPath = path.join(archiveDir, path.basename(ctx.record.sidecarPath));

  // Update the frontmatter status to 'archived' so the file remains
  // self-describing once it leaves the active directory.
  const parsed = parseSkillMd(fs.readFileSync(ctx.record.filePath, 'utf8'));
  parsed.frontmatter.status = 'archived';
  fs.writeFileSync(newMdPath, stringifySkillMd(parsed), { mode: 0o644 });
  fs.copyFileSync(ctx.record.sidecarPath, newSidecarPath);
  fs.writeFileSync(
    path.join(archiveDir, 'reason.json'),
    JSON.stringify(
      {
        archived_at: new Date(ctx.ts).toISOString(),
        archived_by: 'curator',
        reason,
        detail,
        prior_status: ctx.record.frontmatter.status,
      },
      null,
      2,
    ),
    { mode: 0o644 },
  );

  fs.unlinkSync(ctx.record.filePath);
  fs.unlinkSync(ctx.record.sidecarPath);
}

function demoteSkill(ctx: MutationContext): void {
  // Re-read from disk and rewrite atomically.
  const parsed = parseSkillMd(fs.readFileSync(ctx.record.filePath, 'utf8'));
  parsed.frontmatter.status = 'candidate';
  parsed.frontmatter.verified_runs = 1;
  parsed.frontmatter.last_verified_at = new Date(ctx.ts).toISOString();
  fs.writeFileSync(ctx.record.filePath, stringifySkillMd(parsed), { mode: 0o644 });
}

/**
 * Run Pass 1 + Pass 3 across every domain under `rootDir`. Pass 2
 * (LLM-merge of sibling skills) lands in PR-23 and slots in here as
 * an additional pass between 1 and 3.
 */
export function runCurator(
  statsResolver: SkillStatsResolver,
  opts: CuratorOptions = {},
): CuratorReport {
  const rootDir = opts.rootDir ?? '';
  if (!rootDir) {
    throw new Error('runCurator: rootDir is required (defaults are caller-side)');
  }
  const ts = (opts.now ?? Date.now)();
  const failRateThreshold = opts.failRateThreshold ?? DEFAULTS.failRateThreshold;
  const failRateMinRuns = opts.failRateMinRuns ?? DEFAULTS.failRateMinRuns;
  const failWindowMs = opts.failWindowMs ?? envInt('OPENCHROME_CURATOR_FAIL_WINDOW_MS', DEFAULTS.failWindowMs);
  const doubleDemoteWindowMs =
    opts.doubleDemoteWindowMs ?? envInt('OPENCHROME_CURATOR_DOUBLE_DEMOTE_MS', DEFAULTS.doubleDemoteWindowMs);
  const staleArchiveMs = opts.staleArchiveMs ?? envInt('OPENCHROME_CURATOR_STALE_MS', DEFAULTS.staleArchiveMs);
  const untouchedArchiveMs =
    opts.untouchedArchiveMs ?? envInt('OPENCHROME_CURATOR_UNTOUCHED_MS', DEFAULTS.untouchedArchiveMs);

  const report: CuratorReport = {
    run_id: crypto.randomBytes(6).toString('hex'),
    started_at: ts,
    ended_at: ts,
    actions: [],
    errors: [],
    stats: { domains_seen: 0, skills_seen: 0, actions_count: 0 },
  };

  const domains = listDomains(rootDir);
  report.stats.domains_seen = domains.length;

  for (const domain of domains) {
    const records = listSkillsForDomain(domain, { rootDir });
    for (const rec of records) {
      report.stats.skills_seen++;
      // Safety rail #1: never touch user-authored skills.
      if (rec.frontmatter.author !== 'agent') {
        report.actions.push({
          kind: 'skip_user_authored',
          skill_id: rec.skill_id,
          domain,
          reason: 'author is not agent',
          timestamp: ts,
        });
        continue;
      }
      // Safety rail #2: skip unknown schema versions.
      if (rec.frontmatter.schema_version !== 1) {
        report.actions.push({
          kind: 'skip_unknown_schema',
          skill_id: rec.skill_id,
          domain,
          reason: `schema_version=${rec.frontmatter.schema_version}`,
          timestamp: ts,
        });
        continue;
      }
      let stats: SkillRunStats;
      try {
        stats = statsResolver(rec, failWindowMs);
      } catch (e) {
        report.errors.push(`statsResolver threw for ${domain}/${rec.skill_id}: ${(e as Error).message}`);
        continue;
      }
      const ctx: MutationContext = { rootDir, domain, record: rec, ts };

      // ----- Pass 1: Demote / double-demote-archive -----
      const totalRuns = stats.successesInWindow + stats.failuresInWindow;
      const failRate = totalRuns > 0 ? stats.failuresInWindow / totalRuns : 0;
      const wasPromoted = rec.frontmatter.status === 'promoted';
      if (
        wasPromoted &&
        totalRuns >= failRateMinRuns &&
        failRate > failRateThreshold
      ) {
        if (
          stats.demotesInDoubleDemoteWindow >= 1 &&
          !stats.hadInterveningPromotion
        ) {
          archiveSkill(
            ctx,
            'archive_double_demote',
            `fail_rate=${failRate.toFixed(2)} after prior demote within ${doubleDemoteWindowMs}ms`,
          );
          report.actions.push({
            kind: 'archive_double_demote',
            skill_id: rec.skill_id,
            domain,
            reason: `double demote without intervening promotion`,
            timestamp: ts,
          });
          continue;
        }
        demoteSkill(ctx);
        report.actions.push({
          kind: 'demote',
          skill_id: rec.skill_id,
          domain,
          reason: `fail_rate=${failRate.toFixed(2)} over ${totalRuns} runs`,
          timestamp: ts,
        });
        continue; // don't also archive in the same pass
      }

      // ----- Pass 3: Archive stale / untouched -----
      const lastVerifiedMs = Date.parse(rec.frontmatter.last_verified_at);
      const ageVerified = Number.isFinite(lastVerifiedMs) ? ts - lastVerifiedMs : Number.POSITIVE_INFINITY;

      if (
        ageVerified > staleArchiveMs &&
        stats.successesInWindow === 0 &&
        rec.frontmatter.status !== 'archived'
      ) {
        archiveSkill(ctx, 'archive_stale', `last_verified_at older than ${staleArchiveMs}ms with 0 successes in window`);
        report.actions.push({
          kind: 'archive_stale',
          skill_id: rec.skill_id,
          domain,
          reason: `stale: last_verified_at age ${ageVerified}ms`,
          timestamp: ts,
        });
        continue;
      }

      const ageTouched = stats.lastRunAt !== null ? ts - stats.lastRunAt : Number.POSITIVE_INFINITY;
      if (ageTouched > untouchedArchiveMs && rec.frontmatter.status !== 'archived') {
        archiveSkill(ctx, 'archive_untouched', `no skill_run audit for ${untouchedArchiveMs}ms`);
        report.actions.push({
          kind: 'archive_untouched',
          skill_id: rec.skill_id,
          domain,
          reason: `untouched: lastRunAt age ${ageTouched}ms`,
          timestamp: ts,
        });
        continue;
      }
    }
  }

  report.ended_at = (opts.now ?? Date.now)();
  report.stats.actions_count = report.actions.length;
  return report;
}

