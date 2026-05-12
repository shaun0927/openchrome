/**
 * Curator Pass 3 — Promote / recall ranking recompute (Phase 4, #763).
 *
 * Deterministic, no LLM calls.
 *
 * Walks every active (non-archived) skill under `rootDir` and mirrors the
 * latest success counts and last-used timestamps into the `SkillMemoryStore`
 * so the recall layer always sees up-to-date ranking weights without waiting
 * for an explicit `markUsed` call from the contract runtime.
 *
 * Concretely, for each skill record whose sidecar `runs.count` or
 * `sidecar.runs.recent` newest-entry timestamp differs from the store's
 * persisted `successCount` / `lastUsedAt`, Pass 3 calls
 * `store.markUsed(skillId, lastSuccessTs, success)` to flush the delta.
 *
 * This is a best-effort synchronisation — if the store has no record for
 * a skill, the pass skips it rather than creating a new entry (creation
 * belongs to the extractor). Errors per skill are collected and surfaced
 * via `PromoteReport.errors` without aborting the rest of the pass.
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

import { SkillMemoryStore } from '../../core/skill-memory/store.js';
import { listSkillsForDomain } from './extractor.js';

export interface PromoteOptions {
  rootDir?: string;
  /** Test hook: clock. */
  now?: () => number;
}

export interface PromoteReport {
  run_id: string;
  started_at: number;
  ended_at: number;
  /** Number of skill-store records updated. */
  updated: number;
  /** Number of skills skipped because they have no store record. */
  skipped_no_record: number;
  errors: string[];
  stats: {
    domains_seen: number;
    skills_seen: number;
  };
}

function listDomains(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    out.push(entry.name);
  }
  return out;
}

/**
 * Run Pass 3 across every domain under `rootDir`.
 *
 * For each promoted or candidate skill, updates `SkillMemoryStore` with
 * the latest success count and timestamp derived from the sidecar's rolling
 * run log. The caller (runner.ts) is responsible for holding the CuratorLock
 * before invoking this.
 */
export async function runPromote(opts: PromoteOptions = {}): Promise<PromoteReport> {
  const rootDir = opts.rootDir ?? '';
  if (!rootDir) {
    throw new Error('runPromote: rootDir is required');
  }
  const ts = (opts.now ?? Date.now)();

  const report: PromoteReport = {
    run_id: crypto.randomBytes(6).toString('hex'),
    started_at: ts,
    ended_at: ts,
    updated: 0,
    skipped_no_record: 0,
    errors: [],
    stats: { domains_seen: 0, skills_seen: 0 },
  };

  const domains = listDomains(rootDir);
  report.stats.domains_seen = domains.length;

  for (const domain of domains) {
    const store = new SkillMemoryStore({ rootDir, domain });
    const records = listSkillsForDomain(domain, { rootDir });

    for (const rec of records) {
      report.stats.skills_seen++;

      // Only sync active skills; archived ones are frozen.
      if (rec.frontmatter.status === 'archived') continue;

      try {
        const existing = store.get(rec.skill_id);
        if (!existing) {
          report.skipped_no_record++;
          continue;
        }

        // Derive the latest success timestamp from the sidecar's rolling log.
        const recent = rec.sidecar.runs.recent;
        const successEntries = recent.filter((e) => e.ok);
        const latestSuccessTs =
          successEntries.length > 0
            ? Math.max(...successEntries.map((e) => e.ts))
            : null;

        const newSuccessCount = rec.sidecar.runs.count;
        const newLastUsedAt =
          latestSuccessTs !== null ? latestSuccessTs : existing.lastUsedAt;

        // Only flush when something changed — keeps writes minimal.
        const changed =
          newSuccessCount !== existing.successCount ||
          newLastUsedAt !== existing.lastUsedAt;

        if (!changed) continue;

        await store.markUsed(rec.skill_id, newLastUsedAt, newSuccessCount > existing.successCount);
        report.updated++;
      } catch (e) {
        report.errors.push(
          `promote: error updating ${domain}/${rec.skill_id}: ${(e as Error).message}`,
        );
      }
    }
  }

  report.ended_at = (opts.now ?? Date.now)();
  return report;
}
