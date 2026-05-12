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
}

export type SkillFn = () => Promise<unknown>;

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
}
