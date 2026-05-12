/**
 * Skill-graph storage types. Schema preserved verbatim from closed PR #738
 * v2 — the storage backend changed from SQLite to JSON-per-domain (P5 of
 * the portability-harness contract), but the persisted shape of nodes and
 * edges stays the same so #703's executor sees an identical record model.
 *
 * `to_state_distribution` is included from day one so a multi-outcome
 * action can be matched without a follow-up migration.
 */

/** A graph node — one observed page-state hash. */
export interface SkillNode {
  stateHash: string;
  evidence?: unknown;
  thumbnailPath?: string;
  lastSeenAt: number;
  visitCount: number;
}

/**
 * Sorted (by count DESC) distribution of observed `to_state` outcomes for
 * a single edge. Sorting makes inspection cheap and is preserved across
 * reads/writes.
 */
export type ToStateDistribution = Array<{ to_state: string; count: number }>;

/** A graph edge — one (from_state, action_kind, action_args_norm) entry. */
export interface SkillEdge {
  fromState: string;
  actionKind: string;
  actionArgsNorm: string;
  toStateDistribution: ToStateDistribution;
  successCount: number;
  failCount: number;
  lastFailedAt?: number;
  /** Last error string captured by recordFailure(). */
  lastError?: string;
}

/** Composite primary key for an edge. */
export interface EdgeKey {
  fromState: string;
  actionKind: string;
  actionArgsNorm: string;
}

/** Diagnostic snapshot consumed by `oc skill inspect`. */
export interface SkillGraphInspectSummary {
  domain: string;
  nodeCount: number;
  edgeCount: number;
  topEdgesByVisit: Array<{
    from: string;
    actionKind: string;
    successCount: number;
    failCount: number;
  }>;
  recentFailures: Array<{
    from: string;
    actionKind: string;
    failCount: number;
    lastFailedAt: number;
  }>;
}

/**
 * The shape persisted on disk for a single domain. Versioned so a future
 * migration can detect old layouts and rewrite the file. Nodes are stored
 * as an Object keyed by stateHash (cheap point lookup); edges are stored
 * as an Array because the PK is composite and JSON has no native tuple
 * key.
 */
export interface SkillGraphFile {
  schema_version: 1;
  nodes: Record<string, PersistedNode>;
  edges: PersistedEdge[];
}

export interface PersistedNode {
  state_hash: string;
  evidence?: unknown;
  thumbnail_path?: string;
  last_seen_at: number;
  visit_count: number;
}

export interface PersistedEdge {
  from_state: string;
  action_kind: string;
  action_args_norm: string;
  to_state_distribution: ToStateDistribution;
  success_count: number;
  fail_count: number;
  last_failed_at?: number;
  last_error?: string;
}
