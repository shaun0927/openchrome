/**
 * Skill curator Pass 2 — structural sibling merge (Phase 4, #764).
 *
 * Two skills under the same domain that share a graph-anchor prefix AND
 * a meaningful Jaccard intent overlap likely document the same underlying
 * flow at different points in its evolution. Pass 2 clusters them and
 * merges the cluster in-place: the seed (highest verified_runs) becomes
 * the umbrella, non-seed siblings are archived.
 *
 * Structural-only — no LLM. LLM-augmented semantic merge is out of scope
 * per P3 (separate package tracked in #776).
 *
 * Gated by `OPENCHROME_SKILL_MEM_MERGE=1` (checked by the caller).
 *
 * Per #715 v2 P0/P1:
 *   - Clustering input: same graph_node_anchor prefix (first N chars,
 *     default 3) AND Jaccard ≥ 0.70 over stop-word-stripped intent
 *     tokens AND same contract_id.
 *   - On merge: umbrella inherits seed name/intent/body; archived run
 *     histories are unioned and sorted oldest-first so subsequent
 *     recordSuccessfulRun slice(-N) evicts the oldest entry on overflow.
 *   - Never modifies user-authored skills (author !== 'agent').
 *   - Never deletes — only archives.
 *   - Idempotent: re-running on a clean state produces no actions.
 *
 * `runMerge()` is associative — merge order doesn't matter for the
 * structural-only path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { computeSkillId, listSkillsForDomain } from './extractor';
import { parseSkillMd, stringifySkillMd } from './skill-md';
import { STOP_WORDS } from './stop-words';
import { SKILL_RUN_LOG_MAX, SKILL_SCHEMA_VERSION, type SkillRecord, type SkillSidecar } from './types';

// ---- Types -----------------------------------------------------------------

export type MergeActionKind = 'merge' | 'merge_skipped';

export interface MergeAction {
  kind: MergeActionKind;
  skill_id: string;
  domain: string;
  reason: string;
  timestamp: number;
}

export interface MergeOutcome {
  actions: MergeAction[];
  errors: string[];
}

export interface RunMergeOptions {
  rootDir: string;
  domain: string;
  jaccardThreshold?: number;
  prefixChars?: number;
  now?: () => number;
}

export interface ClusterCandidate {
  records: SkillRecord[];
}

// ---- Public helpers (exported for tests) -----------------------------------

/** Tokenize an intent string for Jaccard comparison. */
export function tokenize(intent: string): Set<string> {
  return new Set(
    intent
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}_]+/gu, ''))
      .filter((w) => w.length > 0 && !STOP_WORDS.has(w)),
  );
}

/** Jaccard similarity between two sets. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const v of a) if (b.has(v)) intersection++;
  const unionSize = a.size + b.size - intersection;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

/**
 * Greedy clustering: the cluster seed is the highest-`verified_runs`
 * record. Candidates joining the cluster must share the seed's
 * graph_node_anchor prefix AND clear `jaccardThreshold` against the
 * seed's intent AND share the same `contract_id`.
 *
 * Two skills sharing a prefix-of-zero is meaningless, so `prefixChars`
 * is clamped to a minimum of 1.
 */
export function clusterSkills(
  records: SkillRecord[],
  opts: { jaccardThreshold?: number; prefixChars?: number } = {},
): ClusterCandidate[] {
  const jacc = opts.jaccardThreshold ?? 0.7;
  const prefix = Math.max(1, opts.prefixChars ?? 3);
  const eligible = records
    .filter((r) => r.frontmatter.author === 'agent')
    .filter((r) => r.frontmatter.status !== 'archived');
  const seen = new Set<string>();
  const ranked = [...eligible].sort(
    (a, b) => b.frontmatter.verified_runs - a.frontmatter.verified_runs,
  );
  const clusters: ClusterCandidate[] = [];
  for (const seed of ranked) {
    if (seen.has(seed.skill_id)) continue;
    const seedTokens = tokenize(seed.frontmatter.intent);
    const seedPrefix = seed.frontmatter.graph_node_anchor.slice(0, prefix);
    const cluster: SkillRecord[] = [seed];
    seen.add(seed.skill_id);
    for (const cand of ranked) {
      if (seen.has(cand.skill_id)) continue;
      // Enforce contract_id homogeneity — skills from different contracts
      // must not be merged even if intent/anchor prefix aligns.
      if (cand.sidecar.contract_id !== seed.sidecar.contract_id) continue;
      // Anchor-prefix gate: coarse pre-filter before Jaccard.
      if (cand.frontmatter.graph_node_anchor.slice(0, prefix) !== seedPrefix) continue;
      if (jaccard(seedTokens, tokenize(cand.frontmatter.intent)) < jacc) continue;
      cluster.push(cand);
      seen.add(cand.skill_id);
    }
    if (cluster.length >= 2) clusters.push({ records: cluster });
  }
  return clusters;
}

// ---- Private helpers -------------------------------------------------------

function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}

function archiveSibling(args: {
  rootDir: string;
  domain: string;
  record: SkillRecord;
  mergedIntoSkillId: string;
  ts: number;
}): void {
  const archiveDir = path.join(args.rootDir, args.domain, '.archive', args.record.skill_id);
  fs.mkdirSync(archiveDir, { recursive: true });
  const newMdPath = path.join(archiveDir, path.basename(args.record.filePath));
  const newSidecarPath = path.join(archiveDir, path.basename(args.record.sidecarPath));

  const parsed = parseSkillMd(fs.readFileSync(args.record.filePath, 'utf8'));
  parsed.frontmatter.status = 'archived';
  fs.writeFileSync(newMdPath, stringifySkillMd(parsed), { mode: 0o644 });
  fs.copyFileSync(args.record.sidecarPath, newSidecarPath);
  fs.writeFileSync(
    path.join(archiveDir, 'reason.json'),
    JSON.stringify(
      {
        archived_at: isoUtc(args.ts),
        archived_by: 'curator',
        reason: 'merged_into',
        merged_into_skill_id: args.mergedIntoSkillId,
        prior_status: args.record.frontmatter.status,
      },
      null,
      2,
    ),
    { mode: 0o644 },
  );

  fs.unlinkSync(args.record.filePath);
  fs.unlinkSync(args.record.sidecarPath);
}

// ---- Runner ----------------------------------------------------------------

/**
 * Run Pass 2 (structural sibling merge) across one domain. Idempotent:
 * re-running on a clean state produces no actions.
 *
 * Gating on `OPENCHROME_SKILL_MEM_MERGE=1` is the caller's responsibility.
 */
export function runMerge(opts: RunMergeOptions): MergeOutcome {
  const ts = (opts.now ?? Date.now)();
  const records = listSkillsForDomain(opts.domain, { rootDir: opts.rootDir });
  const clusters = clusterSkills(records, {
    jaccardThreshold: opts.jaccardThreshold,
    prefixChars: opts.prefixChars,
  });
  const actions: MergeAction[] = [];
  const errors: string[] = [];

  for (const cluster of clusters) {
    const seed = cluster.records[0];
    const newSkillId = computeSkillId(seed.frontmatter.graph_node_anchor, seed.sidecar.contract_id);
    const writePath = path.join(opts.rootDir, opts.domain, `${newSkillId}.md`);
    const sidecarPath = path.join(opts.rootDir, opts.domain, `${newSkillId}.json`);

    const aggregateRuns = cluster.records.reduce(
      (sum, r) => sum + r.frontmatter.verified_runs,
      0,
    );

    // Preserve verification provenance from the sibling with the most
    // recent last_verified_at. Using curator runtime ts would make stale
    // clusters appear freshly verified, biasing recall ranking.
    const freshest = cluster.records.reduce((best, r) =>
      Date.parse(r.frontmatter.last_verified_at) > Date.parse(best.frontmatter.last_verified_at)
        ? r
        : best,
    );

    // Structural merge: seed name/intent/body become the umbrella.
    // Re-read the seed's body from disk — SkillRecord carries only
    // frontmatter + sidecar, not the markdown body.
    let umbrellaBody: string;
    let serialized: string;
    try {
      const seedText = fs.readFileSync(seed.filePath, 'utf8');
      const seedParsed = parseSkillMd(seedText);
      umbrellaBody = seedParsed.body;
      const umbrellaFm = {
        schema_version: SKILL_SCHEMA_VERSION as 1,
        name: seed.frontmatter.name,
        domain: opts.domain,
        intent: seed.frontmatter.intent,
        status: seed.frontmatter.status,
        verified_runs: aggregateRuns,
        last_verified_at: freshest.frontmatter.last_verified_at,
        contract_ref: freshest.frontmatter.contract_ref,
        graph_node_anchor: seed.frontmatter.graph_node_anchor,
        author: 'agent' as const,
      };
      serialized = stringifySkillMd({ frontmatter: umbrellaFm, body: umbrellaBody });
    } catch (e) {
      const reason = `merge_parse_failure: ${(e as Error).message}`;
      errors.push(reason);
      actions.push({
        kind: 'merge_skipped',
        skill_id: seed.skill_id,
        domain: opts.domain,
        reason,
        timestamp: ts,
      });
      continue;
    }

    // Write umbrella .md atomically (tmp + rename).
    const tmpMd = writePath + '.tmp';
    fs.writeFileSync(tmpMd, serialized, { mode: 0o644 });
    fs.renameSync(tmpMd, writePath);

    // Union sibling run histories, sorted oldest-first so that a
    // subsequent recordSuccessfulRun slice(-SKILL_RUN_LOG_MAX) evicts the
    // oldest entries on overflow rather than the newest.
    const mergedRecent: SkillSidecar['runs']['recent'] = cluster.records
      .flatMap((r) => r.sidecar.runs.recent)
      .sort((a, b) => a.ts - b.ts)
      .slice(-SKILL_RUN_LOG_MAX);

    const sidecarBody = JSON.stringify(
      {
        schema_version: SKILL_SCHEMA_VERSION,
        skill_id: newSkillId,
        graph_node_anchor: seed.frontmatter.graph_node_anchor,
        contract_id: seed.sidecar.contract_id,
        runs: {
          count: aggregateRuns,
          window_start: isoUtc(ts),
          recent: mergedRecent,
        },
        merged_from: cluster.records.map((r) => r.skill_id),
      },
      null,
      2,
    );
    const tmpSidecar = sidecarPath + '.tmp';
    fs.writeFileSync(tmpSidecar, sidecarBody, { mode: 0o644 });
    fs.renameSync(tmpSidecar, sidecarPath);

    for (const sibling of cluster.records) {
      // The sibling whose skill_id equals newSkillId is the seed — its
      // file was overwritten in place above. Archiving it would delete
      // the file we just wrote, so skip it.
      if (sibling.skill_id === newSkillId) continue;
      try {
        archiveSibling({
          rootDir: opts.rootDir,
          domain: opts.domain,
          record: sibling,
          mergedIntoSkillId: newSkillId,
          ts,
        });
      } catch (e) {
        errors.push(`archive failed for ${sibling.skill_id}: ${(e as Error).message}`);
      }
    }

    actions.push({
      kind: 'merge',
      skill_id: newSkillId,
      domain: opts.domain,
      reason: `merged ${cluster.records.length} siblings (Jaccard structural match, intent="${seed.frontmatter.intent.slice(0, 80)}")`,
      timestamp: ts,
    });
  }

  return { actions, errors };
}
