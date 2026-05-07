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
  /**
   * High-stakes flag (#711 v2). When true AND a voting hook is supplied
   * via ContractRuntimeArgs.beforeIrreversibleAction, the runtime calls
   * the hook between pre-check and skill execution. Disagreement →
   * verdict='escalated' with a `voting_disagreement` evidence record.
   */
  critical?: boolean;
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
  /** True when this record was returned from the idempotency cache
   *  rather than freshly computed. Skill never ran. */
  from_cache?: boolean;
  /** True when the preemptive timer fired and force-aborted the skill. */
  hard_kill?: boolean;
  /**
   * Set when the voting hook on a `critical` contract returned
   * `proceed=false`. Contains the disagreement structure so audit /
   * evidence can replay the dispute without re-querying the providers.
   */
  voting_disagreement?: unknown;
}

/**
 * Skill function. Receives an AbortSignal that fires when the contract's
 * preemptive timer trips (`wall_ms + 5s` grace) — well-behaved skills
 * should observe it and bail early. Cooperative cancellation guarantees
 * the runtime hits its budget; preemption guarantees the runtime
 * cannot be wedged by an unresponsive skill.
 */
export type SkillFn = (signal?: AbortSignal) => Promise<unknown>;

export interface ContractRuntimeArgs {
  contract: Contract;
  skill: SkillFn;
  /** Build a fresh AssertionContext from the live page. Called once per
   *  pre-check and once per post-check attempt. */
  snapshot: () => Promise<AssertionContext>;
  /** Optional audit emitter — defaults to a logAuditEntry-backed adapter. */
  audit?: AuditEmitter;
  /** Optional idempotency cache (PR-12). On cache hit the skill never
   *  runs; the cached TransactionRecord is returned with `from_cache=true`. */
  idempotency?: import('./idempotency').IdempotencyStore;
  /** Optional cache key override. Defaults to computeIdempotencyKey(contract). */
  idempotencyKey?: string;
  /** Test hook: clock for deterministic timestamps. */
  now?: () => number;
  /** Test hook: delay function (defaults to setTimeout-based). */
  delay?: (ms: number) => Promise<void>;
  /** Test hook: timer factory for the preemptive cancellation timer. */
  setTimer?: (handler: () => void, ms: number) => unknown;
  /** Test hook: cancellation paired with `setTimer`. */
  clearTimer?: (handle: unknown) => void;
  /**
   * Voting hook fired between pre-check and skill execution when the
   * contract is `critical: true`. The orchestrator (#711) is the
   * canonical implementation; tests pass simpler fakes. When omitted,
   * critical contracts behave like ordinary ones (no voting).
   *
   * Returning `{ proceed: false }` → verdict='escalated' with the
   * disagreement payload threaded into the TransactionRecord. The skill
   * does not run.
   */
  beforeIrreversibleAction?: BeforeIrreversibleActionHook;
}

/** Result envelope the voting hook returns. */
export type IrreversibleActionDecision =
  | { proceed: true }
  | { proceed: false; reason?: string; disagreement?: unknown };

/**
 * Hook signature consumed by `runWithContract` for `critical` contracts.
 * Concrete implementations live in `src/perception/voting/orchestrator.ts`
 * (multi-model dispatcher) but the runtime only depends on this minimal
 * surface so tests can stub it cheaply.
 */
export type BeforeIrreversibleActionHook = (ctx: {
  contract: Contract;
  txn_id: string;
}) => Promise<IrreversibleActionDecision>;

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
 * Grace period (ms) added to `budget.wall_ms` before the preemptive
 * timer fires. Per #706 v2 — gives a cooperative skill a final chance
 * to honor its AbortSignal before we hard-kill.
 */
const PREEMPTIVE_GRACE_MS = 5000;

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

  // 0. Idempotency cache check — short-circuit before validation /
  //    pre-check. A cached success is a settled artifact; nothing else
  //    to do but return it (with from_cache=true) and emit one fresh
  //    audit row so the audit log records the *retrieval*.
  if (args.idempotency) {
    let key = args.idempotencyKey;
    if (!key) {
      const idem = await import('./idempotency');
      key = idem.computeIdempotencyKey(args.contract);
    }
    const cached = args.idempotency.get(key);
    if (cached && cached.verdict === 'success') {
      const replay: TransactionRecord = {
        ...cached,
        txn_id, // a fresh id for the retrieval event
        started_at: startedAt,
        ended_at: now(),
        wall_ms: now() - startedAt,
        from_cache: true,
      };
      return settle(audit, replay);
    }
  }

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

  // 2.5. Voting hook for critical contracts (#711 integration).
  //      Pre-check has passed; budget timer hasn't started; skill is
  //      not yet running. If two providers disagree we escalate
  //      without consuming the budget.
  if (args.contract.critical && args.beforeIrreversibleAction) {
    let decision: IrreversibleActionDecision;
    try {
      decision = await args.beforeIrreversibleAction({
        contract: args.contract,
        txn_id,
      });
    } catch (e) {
      // Hook failure is treated as a runtime execution error rather
      // than a silent proceed — same blast-radius philosophy as
      // pre-check snapshot failures above.
      return settle(audit, {
        txn_id,
        contract_id: args.contract.id,
        verdict: 'execution_error',
        started_at: startedAt,
        ended_at: now(),
        wall_ms: now() - startedAt,
        retries: 0,
        pre_evidence,
        error_message: `beforeIrreversibleAction hook threw: ${errMsg(e)}`,
      });
    }
    if (!decision.proceed) {
      return settle(audit, {
        txn_id,
        contract_id: args.contract.id,
        verdict: 'escalated',
        started_at: startedAt,
        ended_at: now(),
        wall_ms: now() - startedAt,
        retries: 0,
        pre_evidence,
        escalation: { target: 'human-review' },
        voting_disagreement: decision.disagreement,
        error_message: decision.reason ?? 'voting hook returned proceed=false',
      });
    }
  }

  // 3. Execute skill — two-layer cancellation:
  //    (a) cooperative: skill receives AbortSignal it should observe
  //    (b) preemptive: setTimeout(wall_ms + grace) hard-aborts via the
  //        same AbortController and short-circuits the post-check loop.
  const budgetWallMs = args.contract.budget?.wall_ms;
  const skillStart = now();
  const ctrl = new AbortController();
  const setTimer = args.setTimer ?? ((h, ms) => {
    const t = setTimeout(h, ms);
    if (typeof (t as NodeJS.Timeout).unref === 'function') (t as NodeJS.Timeout).unref();
    return t;
  });
  const clearTimer = args.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  let preemptedHardKill = false;
  let preemptHandle: unknown = null;
  if (budgetWallMs !== undefined) {
    preemptHandle = setTimer(() => {
      preemptedHardKill = true;
      ctrl.abort();
    }, budgetWallMs + PREEMPTIVE_GRACE_MS);
  }

  let skillResult: unknown;
  try {
    skillResult = await args.skill(ctrl.signal);
  } catch (e) {
    if (preemptHandle !== null) clearTimer(preemptHandle);
    if (preemptedHardKill) {
      return settle(audit, {
        txn_id,
        contract_id: args.contract.id,
        verdict: 'budget_exhausted',
        started_at: startedAt,
        ended_at: now(),
        wall_ms: now() - startedAt,
        retries: 0,
        pre_evidence,
        error_message: `skill aborted by preemptive timer (wall_ms=${budgetWallMs} + ${PREEMPTIVE_GRACE_MS}ms grace)`,
        hard_kill: true,
      });
    }
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
  if (preemptHandle !== null) clearTimer(preemptHandle);
  const skillEnd = now();
  if (preemptedHardKill) {
    // Preemptive timer fired but the skill returned anyway (didn't
    // throw on the AbortSignal). Treat as budget_exhausted regardless.
    return settle(audit, {
      txn_id,
      contract_id: args.contract.id,
      verdict: 'budget_exhausted',
      started_at: startedAt,
      ended_at: now(),
      wall_ms: now() - startedAt,
      retries: 0,
      pre_evidence,
      error_message: `skill ignored AbortSignal after preemptive timer (wall_ms=${budgetWallMs})`,
      hard_kill: true,
    });
  }
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
    const successRecord: TransactionRecord = {
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
    };
    // Cache only successes per #706 v2.
    if (args.idempotency) {
      let key = args.idempotencyKey;
      if (!key) {
        const idem = await import('./idempotency');
        key = idem.computeIdempotencyKey(args.contract);
      }
      try {
        args.idempotency.put(key, successRecord);
      } catch {
        // Cache failure must not change the verdict.
      }
    }
    return settle(audit, successRecord);
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
