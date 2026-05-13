/**
 * Skill memory storage types (#712 epic, Phase 3 cleanup — replaces the
 * storage half of closed PR #762).
 *
 * The persisted shape is one JSON file per domain:
 *
 *   <rootDir>/<encodedDomain>/skills.json
 *
 * with the structure:
 *
 *   { schema_version: 2, skills: { [skill_id]: SkillRecord } }
 *
 * `schema_version` is mandatory. The store reads both v1 and v2 records
 * (v1 records are upgraded in memory with `replay_artifact = null` per
 * step; the file is rewritten as v2 on the next idempotent re-record).
 *
 * The recall *ranking* logic (relevance score, recency weighting,
 * LLM-facing payload sizing) is pilot-tier work and intentionally lives
 * outside this module. Core only owns the storage primitive.
 */

import type { ReplayArtifact } from './replay-artifact';

/**
 * v2 = v1 + optional `replay_artifact` per step (#875). Reads are
 * back-compatible: v1 files load and surface `replay_artifact: null`
 * for every step. Writes always produce v2 so freshly-recorded skills
 * carry the latest schema even when no artifact is attached.
 */
export const SKILL_MEMORY_SCHEMA_VERSION = 2;

/** Pre-#875 schema version. Still readable; promoted to v2 on next write. */
export const SKILL_MEMORY_SCHEMA_VERSION_V1 = 1;

/**
 * A single stored skill.
 *
 * Field correspondence with the original SQL schema sketch
 * `skills(skill_id PK, domain, name, steps_json, contract_id,
 *  success_count, last_used_at, frozen_snapshot_path)`:
 *
 *   skill_id              -> skillId
 *   domain                -> domain
 *   name                  -> name
 *   steps_json            -> steps (already-parsed JSON; the file
 *                            stores it inline rather than as an
 *                            opaque string so the JSON-per-domain
 *                            file remains human-inspectable)
 *   contract_id           -> contractId
 *   success_count         -> successCount
 *   last_used_at          -> lastUsedAt (ms epoch; 0 means never used)
 *   frozen_snapshot_path  -> frozenSnapshotPath (absolute path; null
 *                            until a snapshot is written)
 */
export interface SkillRecord {
  skillId: string;
  domain: string;
  name: string;
  steps: unknown;
  contractId: string;
  successCount: number;
  lastUsedAt: number;
  frozenSnapshotPath: string | null;
  /**
   * Per-step replay artifacts (#875). Parallel-indexed with `steps`. When
   * read back from a v1 record the entries are all `null`; the replay tool
   * surfaces `code: "ARTIFACT_MISSING"` rather than synthesizing.
   *
   * When omitted on write (e.g. legacy callers), the store normalises this
   * to an array of nulls sized to `steps.length` so consumers always see a
   * value-typed field. May still be `undefined` if `steps` is not a JS
   * array on write — the store leaves the field absent in that case.
   */
  replayArtifacts?: Array<ReplayArtifact | null>;
  /**
   * Wall-clock ms epoch of the most recent replay that passed (steps +
   * contract). Undefined / 0 means no successful replay has been recorded.
   * Used by `oc_skill_recall` to compute the per-skill `replay_signal`
   * ranking bucket (#856).
   */
  lastReplayPassedAt?: number;
  /**
   * Wall-clock ms epoch of the most recent replay that failed (any non-PASS
   * outcome). Undefined / 0 means no failed replay has been recorded.
   * Used by `oc_skill_recall` ranking.
   */
  lastReplayFailedAt?: number;
  /**
   * Most recent replay-failure error string (truncated for the JSON file).
   * Cleared on a subsequent successful replay. Diagnostic only.
   */
  lastReplayError?: string;

}

/** On-disk shape for `<rootDir>/<encodedDomain>/skills.json` (v2). */
export interface SkillMemoryFile {
  schema_version: typeof SKILL_MEMORY_SCHEMA_VERSION;
  skills: Record<string, SkillRecord>;
}

/**
 * v1 file shape — read-only. Persisted before #875; the store accepts it
 * on read, normalises every record to v2 by setting `replayArtifacts` to
 * an array of nulls, and the next `record()` write promotes the file.
 */
export interface SkillMemoryFileV1 {
  schema_version: typeof SKILL_MEMORY_SCHEMA_VERSION_V1;
  skills: Record<string, Omit<SkillRecord, 'replayArtifacts'>>;
}

/**
 * A frozen snapshot is an opaque blob written exactly once by the
 * caller. The store gzips it and persists it under
 * `<rootDir>/<encodedDomain>/snapshots/<snapshotId>.json.gz`.
 */
export interface FrozenSnapshot {
  /**
   * Free-form payload. The store performs no schema validation — it
   * is the caller's responsibility to ship a JSON-serialisable object
   * with whatever fields the pilot recall layer needs.
   */
  [key: string]: unknown;
}
