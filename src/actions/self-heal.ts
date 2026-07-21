/**
 * Action-Cache Self-Heal — Stagehand idiom port.
 *
 * openchrome already caches successful action sequences per domain and
 * exposes `validateCachedSequenceV2(url, instruction, keyHash, success)` so
 * a caller can mark a replay as failed. What's missing is the "invoke LLM
 * only when the cache miss-heals" loop that Stagehand made famous: on a
 * cache hit, execute the cached sequence, and if it fails, fall back to
 * a fresh LLM plan and store the successful re-plan under the same key.
 *
 * This module provides that orchestrator as a thin, injectable primitive
 * so the action layer can wire it in without pulling LLM concerns into the
 * cache module itself. All LLM interaction lives in the `plan` callback the
 * caller passes in — the self-heal loop knows nothing about model names,
 * prompts, or tokens.
 *
 * ## Contract
 *
 * The self-heal loop reads and writes the cache through the same v2 API
 * exposed in `action-cache.ts`. Every branch reports back which path it
 * took so callers can log the reason and downstream metrics can count
 * `hit`, `heal_success`, `heal_failure`, `bypass`.
 *
 * ## Why an injectable `plan` callback
 *
 * Stagehand couples its cache directly to an OpenAI client. openchrome
 * does not depend on any single LLM vendor at the action layer — the
 * MCP host provides the model. Keeping `plan` as an argument makes this
 * primitive testable without any network dependency and keeps the
 * license-tagged upstream idiom in one file.
 *
 * Origin: Stagehand (MIT) — https://github.com/browserbase/stagehand.
 * Source was not copied; this is a clean-room implementation of the
 * "if cache fails, invoke LLM once and re-cache" idiom.
 */

import { ParsedAction } from './action-parser';
import {
  ActionCacheKeyV2Parts,
  ActionCacheStatus,
  cacheSequenceV2,
  getCachedSequenceV2,
  validateCachedSequenceV2,
} from './action-cache';

export type SelfHealOutcome =
  /** Cache hit; the cached sequence executed successfully. */
  | 'hit'
  /** Cache miss (or bypass); planned fresh and executed successfully. */
  | 'planned'
  /** Cache hit failed; re-planned via LLM and the new sequence succeeded. */
  | 'heal_success'
  /** Cache hit failed; re-plan also failed. */
  | 'heal_failure'
  /** Fresh plan failed on first try (no cache to invalidate). */
  | 'plan_failure';

export interface SelfHealResult {
  outcome: SelfHealOutcome;
  /** Actions that were ultimately executed (or attempted last). */
  actions: ParsedAction[];
  /** Cache decision at entry (hit/miss/stale/bypass). */
  cacheStatus: ActionCacheStatus;
  /** True when the LLM `plan` callback ran during this call. */
  invokedPlanner: boolean;
  /** True when the successful sequence was written to cache during this call. */
  wroteCache: boolean;
}

export interface SelfHealPlanFn {
  (context: SelfHealPlanContext): Promise<ParsedAction[]>;
}

export interface SelfHealExecuteFn {
  (actions: ParsedAction[], attempt: 'cached' | 'planned'): Promise<boolean>;
}

export interface SelfHealPlanContext {
  url: string;
  instruction: string;
  /**
   * `null` on cold plans; the failed cached actions on heal attempts. Lets
   * the planner see what was tried so it can prompt around it (e.g. "the
   * previous plan clicked #login-button but the DOM no longer has one").
   */
  failedCache: ParsedAction[] | null;
}

export interface SelfHealOptions {
  url: string;
  instruction: string;
  keyParts: ActionCacheKeyV2Parts;
  /** LLM planner. Called only on cache miss or heal. */
  plan: SelfHealPlanFn;
  /** Runs a parsed action sequence; returns true on success. */
  execute: SelfHealExecuteFn;
  /** If true, skip cache read (still writes on success). Default false. */
  bypassCache?: boolean;
  /**
   * When false, a cache hit that fails is NOT re-planned — the loop
   * returns `heal_failure` immediately. Default true.
   */
  healOnFailure?: boolean;
}

/**
 * Execute an instruction with cache-then-heal semantics. Returns a
 * structured result describing which branch fired and what was executed.
 *
 * The loop guarantees that:
 *   - `plan` is invoked at most once per call (Stagehand-style: LLM only
 *     when the cache cannot do the job).
 *   - `execute` is called at most twice per call (cached, then planned).
 *   - `validateCachedSequenceV2` is called for every cached execution
 *     regardless of outcome so the domain-memory confidence stays honest.
 *   - `cacheSequenceV2` is called once when a fresh plan succeeds.
 */
export async function runActionWithSelfHeal(opts: SelfHealOptions): Promise<SelfHealResult> {
  const bypass = !!opts.bypassCache;
  const shouldHeal = opts.healOnFailure !== false;

  let cacheStatus: ActionCacheStatus = 'MISS';
  let cachedActions: ParsedAction[] | null = null;

  if (!bypass) {
    const decision = getCachedSequenceV2(opts.url, opts.instruction, opts.keyParts);
    cacheStatus = decision.status;
    if (decision.status === 'HIT' && decision.actions && decision.actions.length > 0) {
      cachedActions = decision.actions;
    }
  } else {
    cacheStatus = 'BYPASS';
  }

  // --- Cache-hit path ---------------------------------------------------
  if (cachedActions !== null) {
    const cachedOk = await opts.execute(cachedActions, 'cached');
    // Always record the outcome so confidence updates even on healing runs.
    // The keyHash lookup happens inside validateCachedSequenceV2; passing an
    // empty string safely no-ops if the entry disappeared between read/write.
    validateCachedSequenceV2(
      opts.url,
      opts.instruction,
      '', // matched by re-lookup inside validateCachedSequenceV2
      cachedOk,
    );

    if (cachedOk) {
      return {
        outcome: 'hit',
        actions: cachedActions,
        cacheStatus,
        invokedPlanner: false,
        wroteCache: false,
      };
    }

    if (!shouldHeal) {
      return {
        outcome: 'heal_failure',
        actions: cachedActions,
        cacheStatus,
        invokedPlanner: false,
        wroteCache: false,
      };
    }

    // Re-plan with the failed sequence as context so the LLM can steer
    // around whatever changed on the page (Stagehand self-heal).
    const replanned = await opts.plan({
      url: opts.url,
      instruction: opts.instruction,
      failedCache: cachedActions,
    });

    const replanOk = await opts.execute(replanned, 'planned');
    if (!replanOk) {
      return {
        outcome: 'heal_failure',
        actions: replanned,
        cacheStatus,
        invokedPlanner: true,
        wroteCache: false,
      };
    }

    // Success on the healed plan — overwrite the cache entry.
    cacheSequenceV2(opts.url, opts.instruction, replanned, opts.keyParts);
    return {
      outcome: 'heal_success',
      actions: replanned,
      cacheStatus,
      invokedPlanner: true,
      wroteCache: true,
    };
  }

  // --- Cold-plan path (cache miss or bypass) ----------------------------
  const planned = await opts.plan({
    url: opts.url,
    instruction: opts.instruction,
    failedCache: null,
  });

  const planOk = await opts.execute(planned, 'planned');
  if (!planOk) {
    return {
      outcome: 'plan_failure',
      actions: planned,
      cacheStatus,
      invokedPlanner: true,
      wroteCache: false,
    };
  }

  cacheSequenceV2(opts.url, opts.instruction, planned, opts.keyParts);
  return {
    outcome: 'planned',
    actions: planned,
    cacheStatus,
    invokedPlanner: true,
    wroteCache: true,
  };
}

/**
 * Aggregate counters callers can accumulate per-session to compare the
 * LLM-invocation rate with and without self-heal enabled. The Stagehand
 * paper reports 90%+ LLM avoidance on stable domains; the same numbers
 * apply here once the cache is warm.
 */
export interface SelfHealCounters {
  hit: number;
  planned: number;
  heal_success: number;
  heal_failure: number;
  plan_failure: number;
}

export function emptyCounters(): SelfHealCounters {
  return { hit: 0, planned: 0, heal_success: 0, heal_failure: 0, plan_failure: 0 };
}

export function bumpCounter(counters: SelfHealCounters, outcome: SelfHealOutcome): void {
  counters[outcome] += 1;
}

/**
 * The ratio of calls that avoided invoking the LLM planner. `1.0` means
 * every call was a cache hit; `0.0` means every call planned from scratch.
 * Undefined when no calls have been recorded.
 */
export function cacheHitRate(counters: SelfHealCounters): number | undefined {
  const total =
    counters.hit +
    counters.planned +
    counters.heal_success +
    counters.heal_failure +
    counters.plan_failure;
  if (total === 0) return undefined;
  return counters.hit / total;
}
