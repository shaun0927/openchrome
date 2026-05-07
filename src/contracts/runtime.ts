/**
 * Outcome Contract runtime — wraps a skill function with pre/post-condition
 * enforcement and a verdict taxonomy that drives the audit log + evidence
 * pipeline (PR-13).
 *
 * Per #706 v2:
 *   - Verdicts: success | precondition_violation | postcondition_violation
 *     | budget_exhausted | execution_error | validation_error | escalated
 *   - Retry uses exponential backoff: delay_ms = min(500 * 2^attempts, 5000)
 *   - Pre-check failure does NOT consume execution budget (skill never runs)
 *   - Each runWithContract() call emits exactly one TransactionRecord
 *
 * Idempotency cache + two-layer (preemptive) cancellation are scoped to
 * PR-12 — this PR ships cooperative budget tracking only.
 *
 * Real audit log writing is wired through the existing logAuditEntry()
 * pipeline. Tests substitute an in-memory emitter to assert on shape.
 */

import * as crypto from 'node:crypto';

import { logAuditEntry } from '../security/audit-logger';

import type { Assertion, Evidence } from './types';
import type { AssertionContext } from './evaluator';
import { evaluate } from './evaluator';
import { validateAssertion, type ValidationError } from './validator';

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
  /** Budget caps (advisory in PR-11, enforced fully in PR-12). */
  budget?: {
    tokens?: number;
    wall_ms?: number;
    cdp_calls?: number;
  };
  /** Optional caller-supplied idempotency key (PR-12 wires the cache). */
  idempotency_key?: string;
  /** Domain label for audit log routing. */
  domain?: string;
}

export type Verdict =
  | 'success'
  | 'precondition_violation'
  | 'postcondition_violation'
  | 'budget_exhausted'
  | 'execution_error'
  | 'validation_error'
  | 'escalated';

export interface TransactionRecord {
  txn_id: string;
  contract_id: string;
  verdict: Verdict;
  started_at: number;
  ended_at: number;
  /** Wall-clock duration in ms (started_at to ended_at). */
  wall_ms: number;
  /** Number of post-check retries actually attempted. */
  retries: number;
  /** Pre-condition evidence (when pre is present). */
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
}

export type SkillFn = () => Promise<unknown>;

export interface ContractRuntimeArgs {
  contract: Contract;
  skill: SkillFn;
  /** Build a fresh AssertionContext from the live page. Called once per
   *  pre-check and once per post-check attempt. */
  snapshot: () => Promise<AssertionContext>;
  /** Optional audit emitter — defaults to a logAuditEntry-backed adapter. */
  audit?: AuditEmitter;
  /** Test hook: clock for deterministic timestamps. */
  now?: () => number;
  /** Test hook: delay function (defaults to setTimeout-based). */
  delay?: (ms: number) => Promise<void>;
}

export interface AuditEmitter {
  emit(record: TransactionRecord): void;
}

/** Default emitter that writes through `logAuditEntry`. */
export class LogAuditEntryEmitter implements AuditEmitter {
  emit(record: TransactionRecord): void {
    logAuditEntry(
      'contract_runtime',
      record.txn_id,
      // Spread the record so audit-log can index any field; redaction
      // engine handles sensitive subtrees automatically.
      record as unknown as Record<string, unknown>,
      undefined,
      {
        status: record.verdict === 'success' ? 'success' : 'error',
        durationMs: record.wall_ms,
      },
    );
  }
}

/** Public helper — derive the canonical audit emitter. */
export function defaultAuditEmitter(): AuditEmitter {
  return new LogAuditEntryEmitter();
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 2;
const BACKOFF_CAP_MS = 5000;

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, attempt), BACKOFF_CAP_MS);
}

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((res) => {
    const t = setTimeout(res, ms);
    if (typeof t.unref === 'function') t.unref();
  });

/**
 * Run a skill under a contract. Always settles (never throws). The
 * returned TransactionRecord is also passed to args.audit (or the
 * default emitter if omitted).
 */
export async function runWithContract(args: ContractRuntimeArgs): Promise<TransactionRecord> {
  const now = args.now ?? Date.now;
  const delay = args.delay ?? defaultDelay;
  const audit = args.audit ?? defaultAuditEmitter();
  const startedAt = now();
  const txn_id = crypto.randomUUID();

  // 1. Validate contract assertions structurally
  const errors: ValidationError[] = [];
  if (args.contract.pre) errors.push(...validateAssertion(args.contract.pre, '$.pre'));
  errors.push(...validateAssertion(args.contract.post, '$.post'));
  if (errors.length > 0) {
    return settle(audit, {
      txn_id,
      contract_id: args.contract.id,
      verdict: 'validation_error',
      started_at: startedAt,
      ended_at: now(),
      wall_ms: now() - startedAt,
      retries: 0,
      validation_errors: errors,
    });
  }

  // 2. Pre-check (skill must not run on pre-fail)
  let pre_evidence: Evidence | undefined;
  if (args.contract.pre) {
    let preCtx: AssertionContext;
    try {
      preCtx = await args.snapshot();
    } catch (e) {
      return settle(audit, {
        txn_id,
        contract_id: args.contract.id,
        verdict: 'execution_error',
        started_at: startedAt,
        ended_at: now(),
        wall_ms: now() - startedAt,
        retries: 0,
        error_message: `snapshot failed during pre-check: ${errMsg(e)}`,
      });
    }
    pre_evidence = evaluate(args.contract.pre, preCtx);
    if (!pre_evidence.passed) {
      return settle(audit, {
        txn_id,
        contract_id: args.contract.id,
        verdict: 'precondition_violation',
        started_at: startedAt,
        ended_at: now(),
        wall_ms: now() - startedAt,
        retries: 0,
        pre_evidence,
      });
    }
  }

  // 3. Execute skill (cooperative budget tracking — preemptive timer is PR-12)
  const budgetWallMs = args.contract.budget?.wall_ms;
  const skillStart = now();
  let skillResult: unknown;
  try {
    skillResult = await args.skill();
  } catch (e) {
    return settle(audit, {
      txn_id,
      contract_id: args.contract.id,
      verdict: 'execution_error',
      started_at: startedAt,
      ended_at: now(),
      wall_ms: now() - startedAt,
      retries: 0,
      pre_evidence,
      error_message: errMsg(e),
    });
  }
  const skillEnd = now();
  if (budgetWallMs !== undefined && skillEnd - skillStart > budgetWallMs) {
    return settle(audit, {
      txn_id,
      contract_id: args.contract.id,
      verdict: 'budget_exhausted',
      started_at: startedAt,
      ended_at: now(),
      wall_ms: now() - startedAt,
      retries: 0,
      pre_evidence,
      error_message: `skill exceeded wall_ms budget (${skillEnd - skillStart}ms > ${budgetWallMs}ms)`,
    });
  }

  // 4. Post-check with retry + backoff
  const maxRetries = Math.max(0, args.contract.on_fail?.retry ?? 0);
  let post_evidence: Evidence | undefined;
  let attempt = 0;
  while (true) {
    let postCtx: AssertionContext;
    try {
      postCtx = await args.snapshot();
    } catch (e) {
      return settle(audit, {
        txn_id,
        contract_id: args.contract.id,
        verdict: 'execution_error',
        started_at: startedAt,
        ended_at: now(),
        wall_ms: now() - startedAt,
        retries: attempt,
        pre_evidence,
        post_evidence,
        error_message: `snapshot failed during post-check: ${errMsg(e)}`,
      });
    }
    post_evidence = evaluate(args.contract.post, postCtx);
    if (post_evidence.passed) break;
    if (attempt >= maxRetries) break;
    // Bail if the next backoff would exceed the remaining wall budget.
    const next = backoffMs(attempt);
    if (
      budgetWallMs !== undefined &&
      now() - startedAt + next > budgetWallMs
    ) {
      break;
    }
    await delay(next);
    attempt++;
  }

  if (post_evidence!.passed) {
    return settle(audit, {
      txn_id,
      contract_id: args.contract.id,
      verdict: 'success',
      started_at: startedAt,
      ended_at: now(),
      wall_ms: now() - startedAt,
      retries: attempt,
      pre_evidence,
      post_evidence,
      skill_result: skillResult,
    });
  }

  // 5. Escalate or postcondition_violation
  const escalateTarget = args.contract.on_fail?.escalate;
  if (escalateTarget === 'human-review' || escalateTarget === 'headed-handoff') {
    return settle(audit, {
      txn_id,
      contract_id: args.contract.id,
      verdict: 'escalated',
      started_at: startedAt,
      ended_at: now(),
      wall_ms: now() - startedAt,
      retries: attempt,
      pre_evidence,
      post_evidence,
      escalation: { target: escalateTarget },
    });
  }
  return settle(audit, {
    txn_id,
    contract_id: args.contract.id,
    verdict: 'postcondition_violation',
    started_at: startedAt,
    ended_at: now(),
    wall_ms: now() - startedAt,
    retries: attempt,
    pre_evidence,
    post_evidence,
  });
}

function settle(audit: AuditEmitter, record: TransactionRecord): TransactionRecord {
  try {
    audit.emit(record);
  } catch {
    // best-effort — audit failure must not change the verdict
  }
  return record;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
