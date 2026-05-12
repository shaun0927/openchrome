/**
 * Curator Pass 1 — Prune (Phase 4, #763).
 *
 * Deterministic, no LLM calls.
 *
 * Two sub-passes run sequentially over every agent-authored, v1 skill:
 *
 *   Sub-pass A — confidence floor
 *     fail_rate = postcondition_violations / total_runs (30-day window)
 *     when fail_rate > 0.30 AND total_runs ≥ 5 AND status === 'promoted'
 *       → demote (status = 'candidate', reset verified_runs to 1)
 *     when demoted twice within 60 days WITHOUT intervening promotion
 *       → archive (move to .archive/ + write reason.json)
 *
 *   Sub-pass B — TTL
 *     last_verified_at older than 30 days AND 0 successes in window
 *       → archive as 'archive_stale'
 *     no skill_run event for 60 days (lastRunAt null or beyond threshold)
 *       → archive as 'archive_untouched'
 *
 * Safety rails:
 *   - Never deletes; only moves to <domain>/.archive/<skill_id>/
 *   - Only touches skills with author === 'agent'
 *   - Idempotent: rerunning on identical state produces an empty action list
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { listSkillsForDomain } from './extractor.js';
import { parseSkillMd, stringifySkillMd } from './skill-md.js';
import {
  SKILL_SCHEMA_VERSION,
  type SkillRecord,
  type SkillSidecar,
} from './types.js';

export type PruneActionKind =
  | 'demote'
  | 'archive_stale'
  | 'archive_untouched'
  | 'archive_double_demote'
  | 'skip_user_authored'
  | 'skip_unknown_schema';

export interface PruneAction {
  kind: PruneActionKind;
  skill_id: string;
  domain: string;
  reason: string;
  timestamp: number;
}

export interface PruneReport {
  run_id: string;
  started_at: number;
  ended_at: number;
  actions: PruneAction[];
  errors: string[];
  stats: {
    domains_seen: number;
    skills_seen: number;
    actions_count: number;
  };
}

/** Per-skill runtime stats the host resolves from its audit log. */
export interface SkillRunStats {
  /** Successful contract runs (verdict === 'success') in the window. */
  successesInWindow: number;
  /** Failed runs (postcondition_violation) in the window. */
  failuresInWindow: number;
  /** ms epoch of the most recent skill_run event (any outcome), or null. */
  lastRunAt: number | null;
  /** Demote events for this skill within doubleDemoteWindowMs. */
  demotesInDoubleDemoteWindow: number;
  /** True iff the last status transition was a promote (resets demote counter). */
  hadInterveningPromotion?: boolean;
}

export type SkillStatsResolver = (record: SkillRecord, windowMs?: number) => SkillRunStats;

export interface PruneOptions {
  rootDir?: string;
  /** Fail-rate cutoff triggering demote. Default 0.30. */
  failRateThreshold?: number;
  /** Minimum total runs before fail-rate is considered. Default 5. */
  failRateMinRuns?: number;
  /** Window for fail-rate measurement. Default 30 days. */
  failWindowMs?: number;
  /** Window for double-demote detection. Default 60 days. */
  doubleDemoteWindowMs?: number;
  /** Archive when last_verified_at is older than this. Default 30 days. */
  staleArchiveMs?: number;
  /** Archive when no skill_run for this duration. Default 60 days. */
  untouchedArchiveMs?: number;
  /** Test hook: clock. */
  now?: () => number;
}

const DEFAULTS = {
  failRateThreshold: 0.3,
  failRateMinRuns: 5,
  failWindowMs: 30 * 24 * 60 * 60 * 1_000,
  doubleDemoteWindowMs: 60 * 24 * 60 * 60 * 1_000,
  staleArchiveMs: 30 * 24 * 60 * 60 * 1_000,
  untouchedArchiveMs: 60 * 24 * 60 * 60 * 1_000,
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

interface MutationCtx {
  rootDir: string;
  domain: string;
  record: SkillRecord;
  ts: number;
}

function archiveSkill(ctx: MutationCtx, reason: PruneActionKind, detail: string): void {
  const archiveDir = path.join(ctx.rootDir, ctx.domain, '.archive', ctx.record.skill_id);
  fs.mkdirSync(archiveDir, { recursive: true });

  const mdDest = path.join(archiveDir, path.basename(ctx.record.filePath));
  const sidecarDest = path.join(archiveDir, path.basename(ctx.record.sidecarPath));

  // Update frontmatter status to 'archived' so the file is self-describing.
  const parsed = parseSkillMd(fs.readFileSync(ctx.record.filePath, 'utf8'));
  parsed.frontmatter.status = 'archived';
  fs.writeFileSync(mdDest, stringifySkillMd(parsed), { mode: 0o644 });
  fs.copyFileSync(ctx.record.sidecarPath, sidecarDest);
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

function demoteSkill(ctx: MutationCtx): void {
  const parsed = parseSkillMd(fs.readFileSync(ctx.record.filePath, 'utf8'));
  parsed.frontmatter.status = 'candidate';
  parsed.frontmatter.verified_runs = 1;
  parsed.frontmatter.last_verified_at = new Date(ctx.ts).toISOString();
  fs.writeFileSync(ctx.record.filePath, stringifySkillMd(parsed), { mode: 0o644 });

  const sidecar: SkillSidecar = {
    schema_version: SKILL_SCHEMA_VERSION,
    skill_id: ctx.record.skill_id,
    graph_node_anchor: ctx.record.sidecar.graph_node_anchor,
    contract_id: ctx.record.sidecar.contract_id,
    runs: {
      count: 1,
      window_start: new Date(ctx.ts).toISOString(),
      recent: [{ txn_id: ctx.record.frontmatter.contract_ref, ok: true, ts: ctx.ts }],
    },
  };
  fs.writeFileSync(ctx.record.sidecarPath, JSON.stringify(sidecar, null, 2), { mode: 0o644 });
}

/**
 * Run Pass 1 prune across every domain under `rootDir`.
 *
 * Returns a PruneReport summarising all mutations. The caller (runner.ts)
 * is responsible for acquiring the CuratorLock before calling this.
 */
export function runPrune(
  statsResolver: SkillStatsResolver,
  opts: PruneOptions = {},
): PruneReport {
  const rootDir = opts.rootDir ?? '';
  if (!rootDir) {
    throw new Error('runPrune: rootDir is required');
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

  const report: PruneReport = {
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

      // Safety rail: never touch user-authored skills.
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

      // Safety rail: skip unknown schema versions.
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
        report.errors.push(
          `statsResolver threw for ${domain}/${rec.skill_id}: ${(e as Error).message}`,
        );
        continue;
      }

      const ctx: MutationCtx = { rootDir, domain, record: rec, ts };

      // ----- Sub-pass A: confidence floor -----
      const totalRuns = stats.successesInWindow + stats.failuresInWindow;
      const failRate = totalRuns > 0 ? stats.failuresInWindow / totalRuns : 0;

      if (
        rec.frontmatter.status === 'promoted' &&
        totalRuns >= failRateMinRuns &&
        failRate > failRateThreshold
      ) {
        if (stats.demotesInDoubleDemoteWindow >= 1 && !stats.hadInterveningPromotion) {
          archiveSkill(
            ctx,
            'archive_double_demote',
            `fail_rate=${failRate.toFixed(2)} after prior demote within ${doubleDemoteWindowMs}ms`,
          );
          report.actions.push({
            kind: 'archive_double_demote',
            skill_id: rec.skill_id,
            domain,
            reason: 'double demote without intervening promotion',
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
        continue; // skip TTL pass in same cycle
      }

      // ----- Sub-pass B: TTL -----
      const lastVerifiedMs = Date.parse(rec.frontmatter.last_verified_at);
      const ageVerified = Number.isFinite(lastVerifiedMs)
        ? ts - lastVerifiedMs
        : Number.POSITIVE_INFINITY;

      if (
        ageVerified > staleArchiveMs &&
        stats.successesInWindow === 0 &&
        rec.frontmatter.status !== 'archived'
      ) {
        archiveSkill(
          ctx,
          'archive_stale',
          `last_verified_at older than ${staleArchiveMs}ms with 0 successes in window`,
        );
        report.actions.push({
          kind: 'archive_stale',
          skill_id: rec.skill_id,
          domain,
          reason: `stale: last_verified_at age ${ageVerified}ms`,
          timestamp: ts,
        });
        continue;
      }

      const ageTouched =
        stats.lastRunAt !== null ? ts - stats.lastRunAt : Number.POSITIVE_INFINITY;
      if (ageTouched > untouchedArchiveMs && rec.frontmatter.status !== 'archived') {
        archiveSkill(
          ctx,
          'archive_untouched',
          `no skill_run audit for ${untouchedArchiveMs}ms`,
        );
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
