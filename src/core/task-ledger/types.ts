/**
 * Persistent async task ledger — public types.
 *
 * The task ledger turns long-running tools (`crawl`, `crawl_sitemap`,
 * `recording`, `oc_evidence_bundle`, `oc_session_snapshot`) into
 * fire-and-forget background jobs with `start / list / get / cancel /
 * wait` verbs. See `docs/architecture/task-ledger.md` (TBD) and issue
 * #855 for the full contract.
 *
 * These types are JSON-serialisable so meta.json files can be read back
 * by any runtime without depending on this module.
 */

/**
 * State machine: PENDING -> RUNNING -> (COMPLETED | FAILED | CANCELLED).
 * Terminal states (COMPLETED / FAILED / CANCELLED) are immutable once
 * committed to meta.json.
 */
export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * The set of registered MCP tools the ledger knows how to launch. The
 * runner looks up the underlying handler in the MCPServer's registry
 * (`getToolHandler(kind)`); any tool name registered on the server can
 * in principle be wrapped, but the canonical set documented for issue
 * #855 is enumerated here so the schema is explicit.
 *
 * NOTE: this is a *type alias only* — the runner does not enforce that
 * the requested kind is a member of this union at runtime. The MCP
 * server's tool registry is the source of truth.
 */
export type TaskKind =
  | 'browser_task'
  | 'crawl'
  | 'crawl_sitemap'
  | 'recording'
  | 'oc_evidence_bundle'
  | 'oc_session_snapshot'
  | string;

export interface TaskError {
  message: string;
  code?: string;
}

export type TaskPhase = 'explore' | 'act' | 'verify' | 'recover' | 'done';
export type BudgetStatus = 'ok' | 'warning' | 'exceeded';

export interface TaskEnvelopePolicy {
  maxToolCalls?: number;
  maxWallMs?: number;
  maxConsecutiveSameTool?: number;
  maxObservationStreak?: number;
  maxFailureStreak?: number;
  maxSameUrlNavigations?: number;
  allowedDomains?: string[];
  checkpointEveryCalls?: number;
}

export interface TaskCounters {
  toolCalls: number;
  actionCalls: number;
  observationCalls: number;
  failureCalls: number;
  consecutiveSameTool: number;
  observationStreak: number;
  failureStreak: number;
  sameUrlNavigations: Record<string, number>;
}

export interface TaskRecentEvent {
  ts: number;
  tool: string;
  ok: boolean;
  summary: string;
}

export interface TaskBudgetDecision {
  status: BudgetStatus;
  exceeded: string[];
  warnings: string[];
  recommended_next?: string;
}

export interface RecordedToolCall {
  ts: number;
  tool: string;
  sessionId: string;
  tenantId?: string;
  keyId?: string;
  principalMode?: string;
  args: Record<string, unknown>;
  durationMs: number;
  ok: boolean;
}

export interface TaskOwner {
  session_id: string;
  tenant_id?: string;
  key_id?: string;
  mode?: string;
}

export interface BrowserLane {
  lane_id: string;
  task_id: string;
  name?: string;
  purpose?: string;
  status: 'open' | 'closing' | 'closed' | 'failed';
  sessionId: string;
  workerId: string;
  targetIds: string[];
  targetStatuses?: Array<{ targetId: string; status: 'open' | 'target_missing' }>;
  created_at: number;
  last_activity_at: number;
  counters: { toolCalls: number; failures: number };
  recovery?: 'target_missing';
}

export interface TaskMeta {
  /** 16-hex SHA-256(kind\x00args_json\x00created_at) */
  task_id: string;
  kind: TaskKind;
  status: TaskStatus;
  /** Owner process id; reaper checks `process.kill(pid, 0)` aliveness. */
  pid: number;
  created_at: number;
  started_at?: number;
  ended_at?: number;
  /** Redacted snapshot of the launch arguments. <=2 KiB after JSON.stringify. */
  args_summary: Record<string, unknown>;
  /** Caller ownership boundary for tenant/session-scoped task APIs. */
  owner?: TaskOwner;
  /** Per-start entropy used only to avoid same-ms id collisions. */
  task_nonce?: string;
  /** Resolves to "<root>/<task_id>/result.json" iff status === COMPLETED. */
  result_path?: string;
  error?: TaskError;
  cancel_requested_at?: number;
  /** Optional host-declared objective for task-level browser harness envelopes (#1034). */
  objective?: string;
  /** Current host-declared phase. OpenChrome records facts; the host decides phase transitions. */
  phase?: TaskPhase;
  /** Deterministic task budget / wandering policy. */
  policy?: TaskEnvelopePolicy;
  counters?: TaskCounters;
  budget_status?: BudgetStatus;
  budget_exceeded?: string[];
  recommended_next?: string;
  recent_events?: TaskRecentEvent[];
  /** Task-scoped browser lanes owned by this task (#1037). */
  lanes?: BrowserLane[];
  last_tool_name?: string;
  last_activity_at?: number;
}


/**
 * A single event appended to the per-task `events.jsonl` file. Events
 * are advisory — meta.json is the source of truth for status. The
 * runner emits `started`, `completed`, `failed`, `cancel_requested`,
 * and `cancelled` events at the obvious transitions. Tool integrations
 * may emit `progress` / `log` events; the base runner does not.
 */
export interface TaskEvent {
  ts: number;
  kind:
    | 'started'
    | 'progress'
    | 'log'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'cancel_requested'
    | 'tool_call'
    | 'budget';
  data?: Record<string, unknown>;
}

/** Filter shape for `TaskStore.list`. */
export interface TaskListFilter {
  status?: TaskStatus | TaskStatus[];
  kind?: TaskKind | TaskKind[];
  /** Maximum rows to return (default: 50). */
  limit?: number;
  /** Only tasks created >= this ms epoch. */
  since?: number;
}
