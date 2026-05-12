/**
 * Pilot Contract Runtime — wraps a skill function with pre/post-condition
 * enforcement and a verdict taxonomy that drives the audit log + evidence
 * pipeline. Phase 3 of the 1.11 cleanup (issue #790).
 *
 * Per #706 v2 + closed reference PR #749:
 *   - Verdicts: success | precondition_violation | postcondition_violation
 *     | budget_exhausted | execution_error | validation_error | escalated
 *   - Retry uses exponential backoff: delay_ms = min(500 * 2^attempts, 5000)
 *   - Pre-check failure does NOT consume execution budget (skill never runs)
 *   - Each `runWithContract()` call emits exactly one `TransactionRecord`
 *   - The runtime ALWAYS settles — never throws, never hangs (the audit
 *     trail is the source of truth, so unhandled rejection paths in the
 *     caller-supplied snapshot / skill / delay must not escape)
 *
 * Activation:
 *   - Public entry points are gated by `isContractRuntimeEnabled()`.
 *     When the flag is off (e.g. operator passed `--pilot` but excluded
 *     `contract_runtime`), the runtime returns a synthetic `execution_error`
 *     record so callers can still log the no-op without branching on null.
 *
 * Codex review carry-forward (rounds 1-6 of PR #749):
 *   - Round 1 (57a1e0d): verdict taxonomy + retry/backoff skeleton.
 *   - Round 2 (355e9bd): always-settles — wrap evaluator + snapshot + delay
 *     throws into `execution_error` instead of letting them escape.
 *   - Round 3 (24481ed): normalize retry count + wall_ms budget so NaN /
 *     Infinity / negative / fractional inputs cannot bypass guards.
 *   - Round 4 (19e1181): reject `pre = null` via the validator rather than
 *     silently skipping; a null literal arrives from JSON payloads and
 *     would let the skill run unguarded under truthy-only checks.
 *   - Round 5 (1ee8e1d): mirror `contract.domain` into every emitted
 *     `TransactionRecord`; handle `escalate: "abort"` as an explicit
 *     postcondition_violation with a recognisable error_message.
 *   - Round 6 (d593354 + 884f963): final P1 hardening — async audit
 *     rejection swallowed, default backoff timer does not pin the event
 *     loop, retry count strictly floors fractional inputs.
 */

import * as crypto from 'node:crypto';

import { logAuditEntry } from '../../security/audit-logger.js';
import type { EvalContext } from '../../contracts/eval-context.js';
import { evaluate } from '../../contracts/evaluate.js';
import { validateAssertion, type ValidationError } from '../../contracts/validator.js';
import { isContractRuntimeEnabled } from '../../harness/flags.js';
import { DEFAULT_CACHE_TTL_MS } from './idempotency.js';
import type {
  AuditEmitter,
  Contract,
  ContractRuntimeArgs,
  TransactionRecord,
  Verdict,
} from './types.js';

const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 2;
const BACKOFF_CAP_MS = 5000;

/** Default emitter that writes through `logAuditEntry`. */
export class LogAuditEntryEmitter implements AuditEmitter {
  emit(record: TransactionRecord): void {
    logAuditEntry(
      'contract_runtime',
      record.txn_id,
      // Spread the record so audit-log can index any field; the redaction
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

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, attempt), BACKOFF_CAP_MS);
}

/**
 * Default delay hook. Uses `Timer.unref()` so a pending backoff does not
 * keep the event loop alive — important when the runtime is wrapped by a
 * caller-side abort that swaps out `delay`. The unref pattern was added
 * during Codex round 6 (884f963) to address a leaked-handle finding.
 */
const defaultDelay = (ms: number): Promise<void> =>
  new Promise((res) => {
    const t = setTimeout(res, ms);
    // Available in Node; the type narrowing keeps DOM-typed builds happy.
    if (typeof (t as { unref?: () => unknown }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  });

/**
 * Run a skill under a contract. Always settles (never throws). The
 * returned `TransactionRecord` is also passed to `args.audit` (or the
 * default `logAuditEntry`-backed emitter if omitted).
 *
 * When the contract-runtime family flag is off, the runtime no-ops and
 * returns a synthetic `execution_error` record so callers can still
 * uniformly log the disabled path. Note the flag check is intentionally
 * the FIRST line — when disabled, none of the runtime's heavier internal
 * paths execute, satisfying P2 (bit-identical behavior when --pilot is
 * unset or contract_runtime is excluded).
 */
export async function runWithContract(args: ContractRuntimeArgs): Promise<TransactionRecord> {
  const now = args.now ?? Date.now;
  const startedAt = now();

  if (!isContractRuntimeEnabled()) {
    const disabled: TransactionRecord = {
      txn_id: crypto.randomUUID(),
      contract_id: args.contract.id,
      verdict: 'execution_error',
      started_at: startedAt,
      ended_at: now(),
      wall_ms: 0,
      retries: 0,
      error_message: 'contract_runtime family is disabled (pilot flag not active)',
    };
    if (args.contract.domain !== undefined) {
      disabled.contract_domain = args.contract.domain;
    }
    // Skip the audit emitter on the disabled path — by design the runtime
    // produces zero side effects when the family flag is off. Callers
    // that need to log no-ops can do so explicitly from the record.
    return disabled;
  }

  const delay = args.delay ?? defaultDelay;
  const audit = args.audit ?? defaultAuditEmitter();
  const txn_id = crypto.randomUUID();

  // Local settle wrapper that auto-injects `contract_domain` so every
  // record this run emits carries the routing label without each call
  // site having to remember to set it. See Codex round 5 (1ee8e1d).
  const emit = (record: TransactionRecord): TransactionRecord =>
    settle(audit, record, args.contract.domain);

  // --- Idempotency cache (#791) -----------------------------------
  // Cache wiring is best-effort: a misbehaving cache must never break
  // the always-settles guarantee, so every cache interaction is wrapped
  // in `tryCache(...)`. The key is derived here; the hit-check is
  // deferred until after `emitAndFinish` is defined so the cached
  // record is re-emitted through the audit pipeline.
  const cache = args.cache;
  const epoch = typeof args.epoch === 'number' && Number.isFinite(args.epoch) ? args.epoch : 0;
  const cacheTtl = args.cache_ttl_ms ?? DEFAULT_CACHE_TTL_MS;
  let cacheKey: string | undefined;
  if (cache) {
    cacheKey = tryCache(() => cache.key(args.contract.id, args.args));
  }

  // Build the AbortSignal that the skill receives. The runtime registers
  // an in-flight entry tied to `(cacheKey, epoch)` so a later epoch can
  // call `controller.abort()` from `cancelInflight()` / a newer arrival.
  // When the cache is absent we still pass an `AbortController.signal`
  // so the skill's signature stays uniform.
  let abortSignal: AbortSignal | undefined;
  let pendingResolve: ((r: TransactionRecord) => void) | undefined;
  let pendingPromise: Promise<TransactionRecord> | undefined;
  if (cache && cacheKey !== undefined) {
    pendingPromise = new Promise<TransactionRecord>((resolve) => {
      pendingResolve = resolve;
    });
    abortSignal = tryCache(() => cache.registerInflight(cacheKey!, epoch, pendingPromise!));
  }

  // Wrap the rest of the routine so the in-flight registration is
  // always released, regardless of which verdict we settle into.
  const finishCache = (record: TransactionRecord): TransactionRecord => {
    if (cache && cacheKey !== undefined) {
      if (record.verdict === 'success' && cacheTtl > 0) {
        tryCache(() => cache.record(cacheKey!, record, cacheTtl));
      }
      tryCache(() => cache.releaseInflight(cacheKey!, epoch));
      pendingResolve?.(record);
    }
    return record;
  };
  const emitAndFinish = (record: TransactionRecord): TransactionRecord =>
    finishCache(emit(record));

  // --- Cache hit check (#791) ---------------------------------------------
  // Now that `emitAndFinish` is defined, perform the lookup. A hit
  // re-emits the cached record with `from_cache: true` so audit consumers
  // can distinguish replays from fresh runs. The original txn_id and
  // timestamps are preserved — the cached row is the source of truth.
  if (cache && cacheKey !== undefined) {
    const cached = tryCache(() => cache.lookup(cacheKey!));
    if (cached !== undefined) {
      return emitAndFinish({ ...cached, from_cache: true });
    }
  }

  // 1. Validate contract assertions structurally. Use `!== undefined`
  //    rather than a truthy check so an explicit `pre: null` from a
  //    JSON / API producer does not silently slip past validation and
  //    skip the pre-check; the validator rejects null with wrong_type
  //    (Codex round 4, 19e1181).
  const errors: ValidationError[] = [];
  if (args.contract.pre !== undefined) {
    const preRes = validateAssertion(args.contract.pre);
    if (!preRes.ok) {
      // Prefix each error path with `$.pre` so audit consumers can tell
      // which clause was malformed without re-parsing the contract.
      for (const e of preRes.errors) {
        errors.push({ path: `$.pre${e.path === '$' ? '' : e.path.slice(1)}`, message: e.message });
      }
    }
  }
  const postRes = validateAssertion(args.contract.post);
  if (!postRes.ok) {
    for (const e of postRes.errors) {
      errors.push({ path: `$.post${e.path === '$' ? '' : e.path.slice(1)}`, message: e.message });
    }
  }
  if (errors.length > 0) {
    return emitAndFinish({
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
  //    only way `pre` reaches here is as a validated `Assertion` —
  //    null has already been rejected via validation_error.
  let pre_evidence: TransactionRecord['pre_evidence'];
  if (args.contract.pre !== undefined) {
    let preCtx: EvalContext;
    try {
      preCtx = await args.snapshot();
    } catch (e) {
      return emitAndFinish({
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
    let preResult;
    try {
      preResult = await evaluate(args.contract.pre, preCtx);
    } catch (e) {
      // The orchestrator wraps evaluator throws into `passed: false`
      // with `details.error`, but a snapshot that re-throws inside a
      // probe call between the await points can still escape. The
      // runtime contract is "always settles", so convert any escape
      // into a verdict. See Codex round 2 (355e9bd).
      return emitAndFinish({
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
    pre_evidence = preResult.evidence;
    if (!preResult.passed) {
      return emitAndFinish({
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

  // 3. Execute skill (cooperative budget tracking).
  //    Normalize wall_ms so non-finite or negative values cannot
  //    silently disable the budget guard (`x > NaN` is always false) or
  //    force every call to fail (`-1` immediately exhausts). See Codex
  //    round 3 (24481ed).
  const budgetWallMs = normalizeBudgetMs(args.contract.budget?.wall_ms);
  const skillStart = now();
  let skillResult: unknown;
  try {
    // Pass the AbortSignal from the idempotency registry through to the
    // skill. Skills that observe the signal can short-circuit a long
    // operation when a newer epoch supersedes the in-flight run.
    skillResult = await args.skill(abortSignal);
  } catch (e) {
    // Aborted-by-cache short-circuits to execution_error with a recognisable
    // marker so audit consumers can grep for preempted runs without having
    // to inspect a per-error-message taxonomy.
    if (abortSignal?.aborted) {
      return emitAndFinish({
        txn_id,
        contract_id: args.contract.id,
        verdict: 'execution_error',
        started_at: startedAt,
        ended_at: now(),
        wall_ms: now() - startedAt,
        retries: 0,
        pre_evidence,
        error_message: `skill aborted by idempotency cache: ${errMsg(e)}`,
      });
    }
    return emitAndFinish({
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
    return emitAndFinish({
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
  //    silently. See Codex round 3 (24481ed) and round 6 (d593354).
  const maxRetries = normalizeRetryCount(args.contract.on_fail?.retry);
  let post_evidence: TransactionRecord['post_evidence'];
  let postPassed = false;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let postCtx: EvalContext;
    try {
      postCtx = await args.snapshot();
    } catch (e) {
      return emitAndFinish({
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
    let postResult;
    try {
      postResult = await evaluate(args.contract.post, postCtx);
    } catch (e) {
      return emitAndFinish({
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
    post_evidence = postResult.evidence;
    postPassed = postResult.passed;
    if (postPassed) break;
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
      // of letting it escape and skip the audit emission. See Codex
      // round 2 (355e9bd).
      return emitAndFinish({
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

  if (postPassed) {
    return emitAndFinish({
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

  // 5. Escalate or postcondition_violation. The three escalate values
  //    are handled distinctly: 'human-review' / 'headed-handoff' route
  //    to the 'escalated' verdict; 'abort' is an explicit "settle as
  //    failed, do not escalate" so the audit trail records that the
  //    operator opted out of human review on this contract. See Codex
  //    round 5 (1ee8e1d).
  const escalateTarget = args.contract.on_fail?.escalate;
  if (escalateTarget === 'human-review' || escalateTarget === 'headed-handoff') {
    return emitAndFinish({
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
  return emitAndFinish({
    txn_id,
    contract_id: args.contract.id,
    verdict: 'postcondition_violation',
    started_at: startedAt,
    error_message:
      escalateTarget === 'abort'
        ? 'on_fail.escalate=abort: settled as postcondition_violation without escalation'
        : undefined,
    ended_at: now(),
    wall_ms: now() - startedAt,
    retries: attempt,
    pre_evidence,
    post_evidence,
  });
}

/**
 * Emit a record through the audit pipeline. The contract's optional
 * `domain` is back-filled here so every `TransactionRecord` carries
 * routing metadata even when call sites omit it from the literal.
 *
 * Both sync throws and rejected promises from the emitter are swallowed
 * (best-effort) so an unhealthy audit sink cannot change the verdict.
 * Codex round 6 (884f963) hardened the async path specifically.
 */
function settle(
  audit: AuditEmitter,
  record: TransactionRecord,
  contractDomain?: string,
): TransactionRecord {
  if (contractDomain !== undefined && record.contract_domain === undefined) {
    record.contract_domain = contractDomain;
  }
  try {
    const r = audit.emit(record);
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      (r as Promise<unknown>).catch(() => {
        // best-effort — async audit failure must not change the verdict
      });
    }
  } catch {
    // best-effort — sync audit failure must not change the verdict
  }
  return record;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Coerce a caller-supplied retry count to a finite non-negative integer.
 * Returns 0 for `undefined`, `NaN`, `Infinity`, negative, or fractional
 * inputs. Floors fractional values defensively so `1.7` does not behave
 * like 2 retries silently.
 */
function normalizeRetryCount(retry: unknown): number {
  if (typeof retry !== 'number' || !Number.isFinite(retry)) return 0;
  return Math.max(0, Math.floor(retry));
}

/**
 * Coerce a caller-supplied wall_ms budget to a finite positive integer
 * or `undefined` (no budget). Non-finite or negative inputs disable the
 * budget rather than silently mis-evaluating: `x > NaN` is always
 * false, which would let every call slip past the guard, and a
 * negative budget would exhaust immediately for any execution time.
 */
/**
 * Best-effort cache helper. Cache operations (key derivation, lookup,
 * record, registry maintenance) must never break the runtime's
 * always-settles guarantee, so every call site routes through this
 * wrapper. A throwing cache simply degrades the call to the uncached
 * path; we deliberately do NOT log here — the audit pipeline already
 * captures the eventual verdict, and a noisy stderr would mask the
 * primary failure mode.
 */
function tryCache<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function normalizeBudgetMs(ms: number | undefined): number | undefined {
  if (ms === undefined) return undefined;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  return Math.floor(ms);
}

// Re-export the runtime types so consumers can `import { Contract } from '.../runtime'`.
export type { Contract, ContractRuntimeArgs, AuditEmitter, TransactionRecord, Verdict };
