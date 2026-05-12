/**
 * Verified Skill Memory types (#712, #713).
 *
 * The on-disk schema is a YAML-frontmatter Markdown file at
 * `~/.openchrome/skills/<domain>/<skill_id>.md` with a sidecar
 * `<skill_id>.json` that mirrors machine-readable fields plus a
 * rolling success log.
 *
 * `schema_version: 1` is mandatory. Future field additions bump this
 * value; the curator (#715) ignores files with an unknown schema and
 * surfaces a warning rather than crashing the load path.
 */

export const SKILL_SCHEMA_VERSION = 1;

export type SkillStatus = 'candidate' | 'promoted' | 'archived';
export type SkillAuthor = 'agent' | 'user';

/** YAML frontmatter — the canonical contract between extractor + curator. */
export interface SkillFrontmatter {
  schema_version: typeof SKILL_SCHEMA_VERSION;
  /** [a-z0-9._-]{1,64} */
  name: string;
  /** eTLD+1 host. */
  domain: string;
  /** Free-text description (≤ 512 chars). Informational only. */
  intent: string;
  status: SkillStatus;
  verified_runs: number;
  /** ISO-8601 UTC timestamp ending in Z. */
  last_verified_at: string;
  /** Audit-log txn_id pointing at the most recent verification. */
  contract_ref: string;
  /** Hex `state_hash` from #702 — entry node in the skill graph. */
  graph_node_anchor: string;
  author: SkillAuthor;
  budget?: {
    tokens_typical?: number;
    wall_ms_typical?: number;
  };
}

/** Sidecar JSON shape (read by the curator's stats passes). */
export interface SkillSidecar {
  schema_version: typeof SKILL_SCHEMA_VERSION;
  skill_id: string;
  graph_node_anchor: string;
  contract_id: string;
  /** Rolling-window success log capped at SKILL_RUN_LOG_MAX entries. */
  runs: {
    count: number;
    window_start: string;
    recent: Array<{ txn_id: string; ok: boolean; ts: number }>;
  };
}

/** Maximum entries kept in the sidecar's rolling log. */
export const SKILL_RUN_LOG_MAX = 50;

/** A parsed SKILL.md (frontmatter + body). */
export interface SkillFile {
  frontmatter: SkillFrontmatter;
  body: string;
}

/** Combined view used by recall (#714) + curator (#715). */
export interface SkillRecord {
  skill_id: string;
  filePath: string;
  sidecarPath: string;
  frontmatter: SkillFrontmatter;
  sidecar: SkillSidecar;
}
