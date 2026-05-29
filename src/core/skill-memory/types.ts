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
 *   { schema_version: 3, skills: { [skill_id]: SkillRecord } }
 *
 * `schema_version` is mandatory. The store reads v1, v2, and v3 records:
 *   - v1 records are upgraded in memory with `replay_artifact = null` per
 *     step and `codegen_artifacts = []`; the file is rewritten as v3 on
 *     the next idempotent re-record.
 *   - v2 records are upgraded in memory with `codegen_artifacts = []`.
 *
 * The recall *ranking* logic (relevance score, recency weighting,
 * LLM-facing payload sizing) is pilot-tier work and intentionally lives
 * outside this module. Core only owns the storage primitive.
 */

import type { ReplayArtifact } from './replay-artifact';

/**
 * v3 = v2 + optional `codegen_artifacts` at the skill level (#1430).
 * Reads are back-compatible: v1/v2 files load cleanly; the missing field
 * normalises to `[]` in memory. Writes always produce v3.
 */
export const SKILL_MEMORY_SCHEMA_VERSION = 3;

/** Pre-#875 schema version. Still readable; promoted to v3 on next write. */
export const SKILL_MEMORY_SCHEMA_VERSION_V1 = 1;

/** Pre-#1430 schema version. Still readable; promoted to v3 on next write. */
export const SKILL_MEMORY_SCHEMA_VERSION_V2 = 2;

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

  /**
   * Promotion state (#1431 Part 2). Skills move
   *   `recorded` → `re_verified` → `recallable`
   * and `quarantined` is a terminal exclusion state. `oc_skill_recall`
   * filters to `re_verified` + `recallable` by default; pass
   * `include_unpromoted: true` to see `recorded` ones, and
   * `include_quarantined: true` to see quarantined ones.
   *
   * Records persisted before #1431 normalise to `recorded` on read so
   * recall keeps its v1.x semantics unchanged unless promotion is
   * actively in use.
   */
  promotionState?: 'recorded' | 're_verified' | 'recallable' | 'quarantined';
  /** Wall-clock ms epoch of the last promotion-state transition. */
  promotionStateAt?: number;
  /** Truncated reason string when promotionState === 'quarantined'. */
  promotionQuarantineReason?: string;

  /**
   * Codegen artifact pointers persisted at record time (#1430). Each entry
   * points to a file written by the opt-in codegen pipeline
   * (`OPENCHROME_CODEGEN` / `--codegen`). Paths are stored relative to the
   * skill store rootDir so the record is portable across machines (per SSOT
   * #1359 "portable local artifacts").
   *
   * When omitted on read (v1/v2 records), the store normalises to `[]`.
   * When codegen is disabled at record time the field is written as `[]`.
   */
  codegenArtifacts?: CodegenArtifactPointer[];

  /**
   * Explicit provenance for this record (#1457 PR-4 / SSOT Pillar D —
   * "explicit provenance for every promoted skill or memory record"). Optional
   * and additive: legacy records read back with `provenance` absent, which
   * consumers treat as `source: 'unknown'`. The core store records what the
   * writer claimed; it does NOT itself verify (P4/P7 — verification is the
   * host's / pilot curator's job), so `verified` lets recall distinguish
   * Verified-Skill-Loop-eligible records from unverified direct writes.
   */
  provenance?: SkillProvenance;
}

/**
 * Where a {@link SkillRecord} came from and whether its writer claimed it was
 * contract-verified. Part of the Verified Skill Loop (see
 * docs/roadmap/ssot-decisions.md D2).
 */
export interface SkillProvenance {
  /**
   * `host` = a direct `oc_skill_record` MCP call; `curator` = the pilot
   * auto-extractor (contract-verified); `replay` = a replay-outcome write;
   * `unknown` = legacy / normalized.
   */
  source: 'host' | 'curator' | 'replay' | 'unknown';
  /** Wall-clock ms epoch of the first record write (stable across re-records). */
  recordedAt: number;
  /** Contract id the skill is bound to, surfaced for audit (mirrors contractId). */
  contractRef?: string;
  /**
   * Whether the writer asserted this skill came from a contract-verified
   * success. Defaults to `false` for direct host writes — the core store never
   * sets it `true` on its own. Only a verified extractor / promotion path may
   * record `true`.
   */
  verified?: boolean;
}

/**
 * A pointer to one codegen output file produced by the `--codegen` pipeline.
 * Stored relative to the skill store rootDir for portability (#1359).
 */
export interface CodegenArtifactPointer {
  /** Codegen output format. Matches the `CodegenMode` values (never 'off'). */
  kind: 'puppeteer' | 'playwright' | 'mcp-replay';
  /**
   * Path to the artifact file, relative to the SkillMemoryStore rootDir.
   * Use `path.join(rootDir, pointer.path)` to resolve to an absolute path.
   */
  path: string;
  /** Wall-clock ms epoch when the artifact file was created. */
  created_at: number;
}

/** On-disk shape for `<rootDir>/<encodedDomain>/skills.json` (v3). */
export interface SkillMemoryFile {
  schema_version: typeof SKILL_MEMORY_SCHEMA_VERSION;
  skills: Record<string, SkillRecord>;
}

/**
 * v1 file shape — read-only. Persisted before #875; the store accepts it
 * on read, normalises every record to v3 by setting `replayArtifacts` to
 * an array of nulls and `codegenArtifacts` to `[]`, and the next
 * `record()` write promotes the file.
 */
export interface SkillMemoryFileV1 {
  schema_version: typeof SKILL_MEMORY_SCHEMA_VERSION_V1;
  skills: Record<string, Omit<SkillRecord, 'replayArtifacts' | 'codegenArtifacts'>>;
}

/**
 * v2 file shape — read-only. Persisted before #1430; the store accepts it
 * on read, normalises every record to v3 by setting `codegenArtifacts` to
 * `[]`, and the next `record()` write promotes the file.
 */
export interface SkillMemoryFileV2 {
  schema_version: typeof SKILL_MEMORY_SCHEMA_VERSION_V2;
  skills: Record<string, Omit<SkillRecord, 'codegenArtifacts'>>;
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
