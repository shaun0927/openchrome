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
  /** True when this record was returned from the idempotency cache
   *  rather than freshly computed. Skill never ran. */
  from_cache?: boolean;
  /** True when the preemptive timer fired and force-aborted the skill. */
  hard_kill?: boolean;
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
 * Grace period (ms) added to `budget.wall_ms` before the preemptive
 * timer fires. Per #706 v2 — gives a cooperative skill a final chance
 * to honor its AbortSignal before we hard-kill.
 */
const PREEMPTIVE_GRACE_MS = 5000;

/**
 * Run a skill under a contract. Always settles (never throws). The
 * returned TransactionRecord is also passed to args.audit (or the
 * default emitter if omitted).
 *
 * Idempotency proceeds in three layers (per #706 v2):
 *   - **Settled cache** (`store.get`): durable replay of prior successes.
 *   - **In-flight registry** (`store.getPending` / `reservePending`):
 *     stampede protection so concurrent duplicates of the same key wait
 *     for the original execution rather than re-entering the skill.
 *   - **Fresh execution**: only when both layers miss.
 */
export async function runWithContract(args: ContractRuntimeArgs): Promise<TransactionRecord> {
  const now = args.now ?? Date.now;
  const audit = args.audit ?? defaultAuditEmitter();

  // 0. Idempotency: settled-cache short-circuit, then in-flight short-circuit.
  //    Caching only engages when a disambiguator is available (caller
  //    `idempotencyKey` or `contract.idempotency_key`). Without one, two
  //    logically-distinct invocations of the same contract definition
  //    would collide on the same hash and the second would silently
  //    skip its required side effects — exactly the over-broad caching
  //    case codex flagged. A defined disambiguator is now a precondition
  //    for caching; otherwise the runtime falls through to a fresh run.
  const idemKey = resolveIdemKey(args);
  if (args.idempotency && idemKey) {
    // 0a. Settled cache hit. Cache reads are wrapped because a faulty
    //     store (closed SQLite handle, schema drift) must not break the
    //     "always settles" guarantee — degrade to a fresh run instead.
    const cached = safeStoreCall(() => args.idempotency!.get(idemKey));
    if (cached && cached.verdict === 'success') {
      return emitReplay(audit, cached, now);
    }

    // 0b. In-flight registry hit — another caller is already running
    //     this exact (contract, args). Wait for it instead of executing
    //     a duplicate skill. Without this, two concurrent calls both
    //     observe a cache miss and both run the skill, defeating the
    //     stampede-protection guarantee. The pending promise never
    //     rejects (runWithContract always settles); the original
    //     execution's TransactionRecord is replayed for this caller.
    const inflight = safeStoreCall(() => args.idempotency!.getPending(idemKey));
    if (inflight) {
      const orig = await inflight;
      return emitReplay(audit, orig, now);
    }

    // 0c. Reserve our slot before any further await so a concurrent
    //     caller that arrives while the skill is running observes our
    //     in-flight promise (path 0b) and does not race-execute. If the
    //     reservation itself throws (broken store), drop to an uncached
    //     run — better than a hard failure of the contract.
    let resolveOurs!: (record: TransactionRecord) => void;
    const ours = new Promise<TransactionRecord>((res) => {
      resolveOurs = res;
    });
    const reserved = safeStoreCall(() => {
      args.idempotency!.reservePending(idemKey, ours);
      return true;
    });
    if (!reserved) return runInner(args, undefined, now, audit);

    try {
      const record = await runInner(args, idemKey, now, audit);
      resolveOurs(record);
      return record;
    } finally {
      safeStoreCall(() => args.idempotency!.releasePending(idemKey));
    }
  }

  return runInner(args, undefined, now, audit);
}

/** Resolve the cache key for this invocation. Returns undefined when no
 *  disambiguator is available — in that case the runtime skips the
 *  cache entirely so two logically-distinct calls of the same contract
 *  definition cannot collide on a hash that would replay the wrong
 *  result. */
function resolveIdemKey(args: ContractRuntimeArgs): string | undefined {
  if (args.idempotencyKey) return args.idempotencyKey;
  if (args.contract.idempotency_key) {
    // Hash matches the SQLite cache key the caller can correlate
    // against the audit log — same canonicalization either way.
    // Lazy require keeps the (synchronous) common path browser-safe.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const idem = require('./idempotency') as typeof import('./idempotency');
    return idem.computeIdempotencyKey(args.contract);
  }
  return undefined;
}

/** Run a store call defensively. If the store throws (closed handle,
 *  malformed row, file system error) the runtime falls back to its
 *  uncached path rather than rejecting — preserving "always settles". */
function safeStoreCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function emitReplay(
  audit: AuditEmitter,
  cached: TransactionRecord,
  now: () => number,
): TransactionRecord {
  const t = now();
  const replay: TransactionRecord = {
    ...cached,
    txn_id: crypto.randomUUID(), // a fresh id for the retrieval event
    started_at: t,
    ended_at: t,
    wall_ms: 0,
    from_cache: true,
  };
  return settle(audit, replay);
}

/**
 * Race a promise against an AbortSignal. Resolves with the promise's
 * value if it settles before abort; rejects on abort regardless of
 * whether the underlying promise eventually settles. This is the
 * preemptive-cancellation safety net: a skill that ignores its
 * AbortSignal would otherwise wedge `await args.skill(signal)` forever
 * — we abandon the awaiter on signal even though the original
 * promise may still complete in the background.
 */
function raceAgainstSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('preemptive abort: signal already aborted before skill start'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(new Error('preemptive abort: signal fired while skill was in flight'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

async function runInner(
  args: ContractRuntimeArgs,
  idemKey: string | undefined,
  now: () => number,
  audit: AuditEmitter,
): Promise<TransactionRecord> {
  const delay = args.delay ?? defaultDelay;
  const startedAt = now();
  const txn_id = crypto.randomUUID();

  // 1. Validate contract assertions structurally. Use `!== undefined`
  //    rather than a truthy check so an explicit `pre: null` from a
  //    JSON / API producer does not silently slip past validation and
  //    skip the pre-check; the validator rejects null with wrong_type.
  const errors: ValidationError[] = [];
  if (args.contract.pre !== undefined) errors.push(...validateAssertion(args.contract.pre, '$.pre'));
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

  // 2. Pre-check (skill must not run on pre-fail). After step 1 the
  //    only way `pre` reaches here is as a validated Assertion — null
  //    has already been rejected via validation_error.
  let pre_evidence: Evidence | undefined;
  if (args.contract.pre !== undefined) {
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
    try {
      pre_evidence = evaluate(args.contract.pre, preCtx);
    } catch (e) {
      // The evaluator is pure, but it calls user-provided probes
      // (`domText`, `domCount`) on the snapshot context — those can
      // throw on bad selectors / probe failures. The runtime contract is
      // "always settles", so convert the throw into a verdict instead of
      // letting it propagate.
      return settle(audit, {
        txn_id,
        contract_id: args.contract.id,
        verdict: 'execution_error',
        started_at: startedAt,
        ended_at: now(),
        wall_ms: now() - startedAt,
        retries: 0,
        error_message: `evaluator threw during pre-check: ${errMsg(e)}`,
      });
    }
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

  // 3. Execute skill — two-layer cancellation:
  //    (a) cooperative: skill receives AbortSignal it should observe
  //    (b) preemptive: setTimeout(wall_ms + grace) hard-aborts via the
  //        same AbortController and short-circuits the post-check loop.
  //    Normalize wall_ms first so non-finite or negative values cannot
  //    silently disable the budget guard (`x > NaN` is always false) or
  //    force every call to fail (`-1` immediately exhausts).
  const budgetWallMs = normalizeBudgetMs(args.contract.budget?.wall_ms);
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
    // Race the skill against the AbortSignal so a non-cooperative skill
    // (one that never resolves and never observes its signal) cannot
    // wedge the runtime past the preemptive deadline. The original skill
    // promise may still settle in the background; we abandon the await.
    skillResult = await raceAgainstSignal(args.skill(ctrl.signal), ctrl.signal);
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

  // 4. Post-check with retry + backoff. Normalize the retry count so a
  //    runtime-supplied non-integer / NaN cannot drive an infinite loop
  //    (`attempt >= NaN` is always false) or expand the retry budget
  //    (`1.5` → silently floors to 2 retries below the comparison).
  const maxRetries = normalizeRetryCount(args.contract.on_fail?.retry);
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
    try {
      post_evidence = evaluate(args.contract.post, postCtx);
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
        error_message: `evaluator threw during post-check: ${errMsg(e)}`,
      });
    }
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
    try {
      await delay(next);
    } catch (e) {
      // Caller-supplied `delay` (e.g., an abortable sleep hook) is
      // allowed to reject. The runtime contract is "always settles", so
      // convert the rejection into an execution_error verdict instead
      // of letting it escape and skip the audit emission.
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
        error_message: `delay() threw between retries: ${errMsg(e)}`,
      });
    }
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
    // Cache only successes per #706 v2. The key was already resolved by
    // the outer reservation path; reuse it instead of recomputing so the
    // pending-registry slot and the cache write line up exactly.
    if (args.idempotency && idemKey) {
      safeStoreCall(() => args.idempotency!.put(idemKey, successRecord));
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

/** Coerce a caller-supplied retry count to a finite non-negative integer.
 *  Returns 0 for `undefined`, `NaN`, `Infinity`, negative, or fractional
 *  inputs. Floors fractional values defensively so `1.7` does not behave
 *  like 2 retries silently.
 */
function normalizeRetryCount(retry: unknown): number {
  if (typeof retry !== 'number' || !Number.isFinite(retry)) return 0;
  return Math.max(0, Math.floor(retry));
}

/** Coerce a caller-supplied wall_ms budget to a finite positive integer
 *  or `undefined` (no budget). Non-finite or negative inputs disable the
 *  budget rather than silently mis-evaluating: `x > NaN` is always
 *  false, which would let every call slip past the guard, and a
 *  negative budget would exhaust immediately for any execution time. */
function normalizeBudgetMs(ms: number | undefined): number | undefined {
  if (ms === undefined) return undefined;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  return Math.floor(ms);
}
