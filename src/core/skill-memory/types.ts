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
 *   { schema_version: 1, skills: { [skill_id]: SkillRecord } }
 *
 * `schema_version: 1` is mandatory. Future field additions bump the
 * value; the store ignores files with an unknown schema rather than
 * crashing the load path.
 *
 * The recall *ranking* logic (relevance score, recency weighting,
 * LLM-facing payload sizing) is pilot-tier work and intentionally lives
 * outside this module. Core only owns the storage primitive.
 */

export const SKILL_MEMORY_SCHEMA_VERSION = 1;

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
}

/** On-disk shape for `<rootDir>/<encodedDomain>/skills.json`. */
export interface SkillMemoryFile {
  schema_version: typeof SKILL_MEMORY_SCHEMA_VERSION;
  skills: Record<string, SkillRecord>;
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
