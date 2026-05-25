/**
 * Pilot Contract Runtime — runtime-specific types.
 *
 * The runtime wraps the M2 DSL (src/contracts/) with retry policy,
 * verdict taxonomy, an always-settles guarantee, and per-contract budget.
 * Types in this file are scoped to the runtime layer; pure data-layer
 * types (Assertion, Evidence, EvaluationResult) live in src/contracts/.
 *
 * See issue #790 (Phase 3 of the OpenChrome 1.11 cleanup) and the closed
 * reference PR #749 for the original taxonomy this re-authors.
 */

import type { Assertion, Evidence } from '../../contracts/types.js';
import type { ValidationError } from '../../contracts/validator.js';

/** Contract definition the runtime evaluates against. */
export interface Contract {
  /** Stable identifier for this contract — used in audit + evidence. */
  id: string;
  /** Optional pre-condition. Skill does NOT run if this fails. */
  pre?: Assertion;
  /** Required post-condition. Determines success/failure verdict. */
  post: Assertion;
  /** Failure handling. */
  on_fail?: {
    /** Number of post-check retries before settling. Default 0. */
    retry?: number;
    /** Action when retries are exhausted. */
    escalate?: 'abort' | 'human-review' | 'headed-handoff';
  };
  /** Budget caps (advisory in Phase 3, enforced fully in a later phase). */
  budget?: {
    tokens?: number;
    wall_ms?: number;
    cdp_calls?: number;
  };
  /** Optional caller-supplied idempotency key (cache wiring is out of scope). */
  idempotency_key?: string;
  /** Domain label for audit log routing. */
  domain?: string;
  /**
   * Marks the skill as performing an irreversible side effect (submit
   * checkout, send transfer, delete record). When true the runtime fires
   * the `beforeIrreversibleAction` hook immediately before invoking the
   * skill so operators can require additional verification. Non-critical
   * contracts (`critical: false` / omitted) pass through unchanged —
   * preserving 1.10.4 behavior by default. See issue #795.
   */
  critical?: boolean;
  /**
   * Operator-supplied action label forwarded to the
   * `beforeIrreversibleAction` hook (e.g. `"submit-checkout"`,
   * `"send-transfer"`). The runtime does not interpret it. Defaults to
   * the contract id when omitted so the hook always receives a non-empty
   * action string.
   */
  action?: string;
}

/** Verdict taxonomy emitted by the runtime. Exactly one per call. */
export type Verdict =
  | 'success'
  | 'precondition_violation'
  | 'postcondition_violation'
  | 'budget_exhausted'
  | 'execution_error'
  | 'validation_error'
  | 'escalated'
  | 'aborted_by_hook';

/** Final settle record emitted by the runtime for every call. */
export interface TransactionRecord {
  txn_id: string;
  contract_id: string;
  /**
   * Mirror of `contract.domain` for audit routing — preserved on every
   * emitted record so downstream filters (per-tenant dashboards,
   * per-feature alerting) can group transactions by domain without
   * having to re-correlate against the originating contract.
   */
  contract_domain?: string;
  verdict: Verdict;
  started_at: number;
  ended_at: number;
  /** Wall-clock duration in ms (started_at to ended_at). */
  wall_ms: number;
  /** Number of post-check retries actually attempted. */
  retries: number;
  /** Pre-condition evidence (when pre is present and ran). */
  pre_evidence?: Evidence;
  /** Post-condition evidence (only on paths that ran post-check). */
  post_evidence?: Evidence;
  /** Validation errors when verdict === 'validation_error'. */
  validation_errors?: ValidationError[];
  /** Error message when verdict === 'execution_error' / 'budget_exhausted'. */
  error_message?: string;
  /** Escalation target when verdict === 'escalated'. */
  escalation?: { target: 'human-review' | 'headed-handoff' };
  /** Result returned by the skill on success paths. */
  skill_result?: unknown;
  /**
   * Decision summary written when verdict === 'aborted_by_hook' — captures
   * the operator-supplied action label and either the deny reason or the
   * external-token issued for an `await-human` resume. The `evidence` from
   * the hook input is intentionally not duplicated here (it is already on
   * `pre_evidence`) to keep the record compact. See issue #795.
   */
  hook_decision?: {
    action: string;
    /** Set when the hook returned `{ proceed: false, reason }`. */
    reason?: string;
    /** Set when the hook returned `{ proceed: 'await-human', externalToken }`. */
    external_token?: string;
  };
  /**
   * True when this record was served from the idempotency cache rather
   * than from a fresh execution. Issue #791. Absent on cache misses
   * (rather than `false`) so audit consumers can grep on presence.
   */
  from_cache?: boolean;
  /**
   * State-graph anchor identifying the entry node this run executed
   * against (curator skill identity is `(state_hash, contract_id)`).
   * Computed via the optional `computeStateHash` callback on
   * `ContractRuntimeArgs` after pre-check passes. Absent when the
   * state-graph family is disabled, when no hasher is wired, or when
   * the URL was unparseable — auto-extractors must treat absence as
   * "skip" rather than synthesising a default. See
   * `src/pilot/state-graph/node-hash.ts` for the algorithm.
   */
  state_hash?: string;
  /**
   * Algorithm version that produced `state_hash`. Persisted so a
   * future algorithm change (e.g. folding a DOM skeleton into the
   * canonical input) can be distinguished from v1 hashes already on
   * disk. Always emitted together with `state_hash`; absent when
   * `state_hash` is absent.
   */
  state_hash_version?: string;
}

/**
 * Skill function executed inside a contract. Receives an optional
 * `AbortSignal` so a preemptive cancellation (issue #791) can interrupt
 * a long-running skill. Skills SHOULD observe the signal — those that
 * ignore it will still run to completion, but the runtime will settle
 * the verdict according to the cancellation, not the skill's eventual
 * return value.
 */
export type SkillFn = (signal?: AbortSignal) => Promise<unknown>;

/**
 * Audit emitter — accepts a `TransactionRecord` and persists / forwards it.
 * The runtime never inspects the return value; throws are swallowed so an
 * unhealthy audit sink cannot change the verdict.
 */
export interface AuditEmitter {
  emit(record: TransactionRecord): void | Promise<void>;
}

/** Arguments accepted by the runtime entry point. */
export interface ContractRuntimeArgs {
  contract: Contract;
  skill: SkillFn;
  /**
   * Build a fresh `EvalContext` from the live page. Called once per
   * pre-check and once per post-check attempt.
   */
  snapshot: () => Promise<import('../../contracts/eval-context.js').EvalContext>;
  /** Optional audit emitter — defaults to a logAuditEntry-backed adapter. */
  audit?: AuditEmitter;
  /** Test hook: clock for deterministic timestamps. */
  now?: () => number;
  /** Test hook: delay function (defaults to a setTimeout-based sleep). */
  delay?: (ms: number) => Promise<void>;
  /**
   * Idempotency cache (#791). When provided, the runtime:
   *   - Returns a cached `success` record on hit, skipping skill +
   *     pre/post-check entirely.
   *   - Records every fresh `success` verdict on miss.
   *   - Registers the in-flight run so a later epoch can preempt it.
   * Omit to disable both behaviours (the runtime no-ops the cache
   * lookups so callers do not pay for what they do not use).
   */
  cache?: import('./idempotency.js').IdempotencyCache;
  /**
   * Caller args forming the second half of the cache key. Required when
   * `cache` is provided AND the call site needs argument-level dedup
   * granularity (e.g., "submit_order with order_id=42" vs ".=43"). When
   * omitted, the cache key derives from `contract.id` alone.
   */
  args?: unknown;
  /**
   * Monotonic epoch counter for preemptive cancellation. A higher epoch
   * arriving for the same cache key aborts the in-flight run. Defaults
   * to 0; callers that do not need preemption can leave it unset.
   */
  epoch?: number;
  /**
   * TTL for cached success verdicts in ms. Defaults to
   * `DEFAULT_CACHE_TTL_MS` (5 minutes). Set to 0 to disable caching
   * while still benefiting from the in-flight registry.
   */
  cache_ttl_ms?: number;
  /**
   * Optional state-graph anchor producer. Invoked at most once per
   * run, after the pre-check passes, to capture the entry-node hash
   * the curator's skill identity is keyed on. The runtime treats this
   * as best-effort: a thrown or rejected callback is swallowed and
   * `state_hash` simply stays absent from the emitted record — the
   * "always settles" guarantee is never compromised by hashing.
   *
   * Two return shapes are accepted for backwards compatibility:
   *
   *   - `string` — legacy v1-only path. The runtime tags the record
   *     with `state_hash_version = 'v1'`.
   *   - `{ hash, version }` — v2-capable path emitted by
   *     `createStateHasher()`. The runtime preserves the supplied
   *     version verbatim so v1 and v2 anchors coexist on the same
   *     `TransactionRecord` schema.
   *
   * `null` / `undefined` in either shape means "no hash" and the
   * record is emitted without `state_hash` / `state_hash_version`.
   *
   * Production wiring: use
   * `src/pilot/state-graph/factory.ts:createStateHasher()`, which
   * folds in the `isStateGraphEnabled()` gate so the callback yields
   * `null` when the family flag is off.
   */
  computeStateHash?: () => Promise<
    | string
    | { hash: string; version: 'v1' | 'v2' }
    | null
  >;
}
