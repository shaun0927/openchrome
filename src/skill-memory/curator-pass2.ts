/**
 * Skill curator Pass 2 — sibling-skill merge (#715 v2).
 *
 * Two skills on the same domain that share a graph-prefix AND a
 * meaningful Jaccard intent overlap likely document the same
 * underlying flow at different points in its evolution. Pass 2
 * clusters them, asks an LLM (`MergeRequester`) to produce an
 * umbrella SKILL.md, and replaces the cluster on success.
 *
 * Per #715 v2 P0/P1:
 *   - Clustering input: same graph-prefix (first N nodes match,
 *     default 3) AND Jaccard ≥ 0.70 over stop-word-stripped intent
 *     tokens.
 *   - On merge: write umbrella, move siblings under .archive/<id>/
 *     with `reason.json { merged_into }`.
 *   - On parse failure / requester error: SKIP the cluster with
 *     `merge_parse_failure` (or `merge_skipped`) action. NO retry
 *     within the same curator run.
 *   - Never modifies user-authored skills (frontmatter.author !==
 *     'agent') — they're filtered out before clustering.
 *   - Never deletes — only archives.
 *
 * Requester is the LLM injection point. Tests pass deterministic
 * fakes so the clustering + write flow is fully covered without
 * a real model.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { computeSkillId, listSkillsForDomain } from './extractor';
import { parseSkillMd, stringifySkillMd, type FrontmatterError } from './skill-md';
import { STOP_WORDS } from './stop-words';
import type { CuratorAction, CuratorActionKind } from './curator';
import { SKILL_RUN_LOG_MAX, SKILL_SCHEMA_VERSION, type SkillRecord, type SkillSidecar } from './types';

export interface ClusterCandidate {
  records: SkillRecord[];
}

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
 * Greedy clustering: each cluster's seed is the highest-`verified_runs`
 * record. Candidates joining the cluster must share the seed's
 * graph_node_anchor prefix AND clear `jaccardThreshold` against the
 * seed. Two skills sharing a prefix-of-zero is meaningless, so the
 * caller should keep `prefixChars` ≥ 2.
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
      // Fix #1: enforce contract_id homogeneity — skills from different
      // contracts must not be merged even if intent/anchor prefix aligns.
      if (cand.sidecar.contract_id !== seed.sidecar.contract_id) continue;
      // Anchor-prefix gate is a coarse pre-filter; actual structural
      // similarity is decided by the Jaccard threshold below.
      if (cand.frontmatter.graph_node_anchor.slice(0, prefix) !== seedPrefix) continue;
      if (jaccard(seedTokens, tokenize(cand.frontmatter.intent)) < jacc) continue;
      cluster.push(cand);
      seen.add(cand.skill_id);
    }
    if (cluster.length >= 2) clusters.push({ records: cluster });
  }
  return clusters;
}

export interface MergeRequest {
  domain: string;
  cluster: SkillRecord[];
}

export interface MergeResultOk {
  ok: true;
  /** Umbrella name (NAME_PATTERN). Caller may sanitize / regenerate. */
  name: string;
  intent: string;
  /** Markdown body for the umbrella SKILL.md. */
  body: string;
}

export interface MergeResultSkip {
  ok: false;
  /** Free-text reason recorded in actions log. */
  reason: string;
}

export type MergeResult = MergeResultOk | MergeResultSkip;

export type MergeRequester = (req: MergeRequest) => Promise<MergeResult>;

export interface RunPass2Options {
  rootDir: string;
  domain: string;
  requester: MergeRequester;
  jaccardThreshold?: number;
  prefixChars?: number;
  now?: () => number;
}

export interface Pass2Outcome {
  actions: CuratorAction[];
  errors: string[];
}

function archiveMergedSibling(args: {
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
        archived_at: new Date(args.ts).toISOString(),
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

function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}

/** Run Pass 2 across one domain. Idempotent (re-running on a clean
 *  state produces no actions). */
export async function runPass2Merge(opts: RunPass2Options): Promise<Pass2Outcome> {
  const ts = (opts.now ?? Date.now)();
  const records = listSkillsForDomain(opts.domain, { rootDir: opts.rootDir });
  const clusters = clusterSkills(records, {
    jaccardThreshold: opts.jaccardThreshold,
    prefixChars: opts.prefixChars,
  });
  const actions: CuratorAction[] = [];
  const errors: string[] = [];

  for (const cluster of clusters) {
    let result: MergeResult;
    try {
      result = await opts.requester({ domain: opts.domain, cluster: cluster.records });
    } catch (e) {
      const reason = `merge requester threw: ${(e as Error).message}`;
      errors.push(reason);
      pushSkip(actions, cluster, opts.domain, ts, reason);
      continue;
    }

    if (!result.ok) {
      pushSkip(actions, cluster, opts.domain, ts, result.reason);
      continue;
    }

    const seed = cluster.records[0];
    const newSkillId = computeSkillId(seed.frontmatter.graph_node_anchor, seed.sidecar.contract_id);
    const writePath = path.join(opts.rootDir, opts.domain, `${newSkillId}.md`);
    const sidecarPath = path.join(opts.rootDir, opts.domain, `${newSkillId}.json`);

    const aggregateRuns = cluster.records.reduce(
      (sum, r) => sum + r.frontmatter.verified_runs,
      0,
    );

    const merged = {
      frontmatter: {
        schema_version: SKILL_SCHEMA_VERSION as 1,
        name: result.name,
        domain: opts.domain,
        intent: result.intent.slice(0, 512),
        status: seed.frontmatter.status,
        verified_runs: aggregateRuns,
        last_verified_at: isoUtc(ts),
        contract_ref: seed.frontmatter.contract_ref,
        graph_node_anchor: seed.frontmatter.graph_node_anchor,
        author: 'agent' as const,
      },
      body: result.body,
    };

    let serialized: string;
    try {
      serialized = stringifySkillMd(merged);
    } catch (e) {
      const reason = `merge_parse_failure: ${(e as FrontmatterError).message}`;
      errors.push(reason);
      pushSkip(actions, cluster, opts.domain, ts, reason);
      continue;
    }

    // Write umbrella .md and sidecar .json atomically (tmp + rename) so
    // a crash mid-write cannot leave a half-merged record on disk.
    const tmpMd = writePath + '.tmp';
    fs.writeFileSync(tmpMd, serialized, { mode: 0o644 });
    fs.renameSync(tmpMd, writePath);
    // Carry forward the union of sibling run histories so that
    // recordSuccessfulRun (which recomputes verified_runs/status solely from
    // existingSidecar.runs.recent) does not reset the umbrella back to
    // candidate on the very next successful run.
    // Sort oldest-first (append order) to match recordSuccessfulRun semantics:
    // it appends a new run then does slice(-SKILL_RUN_LOG_MAX), which drops the
    // front of the array. With oldest-first that drops the oldest entries on
    // overflow — the correct behaviour. Newest-first would instead drop the
    // newest pre-merge entries, silently regressing verified_runs/status.
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
        runs: { count: aggregateRuns, window_start: isoUtc(ts), recent: mergedRecent },
        merged_from: cluster.records.map((r) => r.skill_id),
      },
      null,
      2,
    );
    const tmpSidecar = sidecarPath + '.tmp';
    fs.writeFileSync(tmpSidecar, sidecarBody, { mode: 0o644 });
    fs.renameSync(tmpSidecar, sidecarPath);

    for (const sibling of cluster.records) {
      // The sibling whose skill_id equals newSkillId is the seed — its file
      // was overwritten in place with the umbrella content above. Archiving
      // it would delete the file we just wrote, so skip it.
      if (sibling.skill_id === newSkillId) continue;
      try {
        archiveMergedSibling({
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
      kind: 'merge' as CuratorActionKind,
      skill_id: newSkillId,
      domain: opts.domain,
      reason: `merged ${cluster.records.length} siblings (intent="${result.intent.slice(0, 80)}")`,
      timestamp: ts,
    });
  }

  return { actions, errors };
}

function pushSkip(
  actions: CuratorAction[],
  cluster: ClusterCandidate,
  domain: string,
  ts: number,
  reason: string,
): void {
  // Use the seed's id as the action key — easiest for operators to find.
  actions.push({
    kind: 'merge_skipped' as CuratorActionKind,
    skill_id: cluster.records[0].skill_id,
    domain,
    reason,
    timestamp: ts,
  });
}
