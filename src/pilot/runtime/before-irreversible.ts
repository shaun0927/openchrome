/**
 * `beforeIrreversibleAction` hook — Phase 3 of the OpenChrome 1.11 cleanup
 * (issue #795, replaces the cherry-pick from closed PR #756).
 *
 * The hook fires inside `runWithContract()` immediately before the skill
 * (the "irreversible action") executes, but ONLY for contracts flagged
 * `critical: true`. This gives operators a single chokepoint to require
 * additional verification — manual confirm, MFA challenge, audit-trail
 * write — before the skill performs a side effect that cannot be undone
 * (submit checkout, send transfer, delete record).
 *
 * Activation:
 *   - The hook firing path is gated by `isContractRuntimeEnabled()` via
 *     its only caller, `runWithContract()`. When the contract runtime
 *     family is off, `runWithContract()` short-circuits to the disabled
 *     no-op path BEFORE this module is exercised. As a result the hook is
 *     unreachable when `--pilot` is unset, satisfying the P2 1.10.4
 *     behavior-preserved invariant.
 *   - Even with the runtime enabled, non-critical contracts pass through
 *     unchanged: `runWithContract()` does not invoke the hook unless
 *     `contract.critical === true`.
 *
 * Operator API:
 *   - `registerBeforeIrreversibleHook(hook)` installs a single hook,
 *     replacing any previously registered hook. The default registered
 *     hook is a no-op pass-through that always returns `{ proceed: true }`
 *     so the 1.10.4 behavior is preserved when no operator registers a
 *     custom hook.
 *   - Replacement emits a `console.error` warning so operators that
 *     accidentally double-register can spot the override during a smoke
 *     test. Per CLAUDE.md `console.log` is forbidden — it corrupts the
 *     MCP JSON-RPC stream on stdout.
 *   - `resetBeforeIrreversibleHookForTests()` restores the default no-op
 *     hook; intended only for test setup/teardown.
 *
 * Hook contract:
 *   - The hook receives `{ contractId, action, evidence }` describing the
 *     contract about to fire, the operator-supplied action label, and any
 *     pre-condition evidence the runtime has already gathered (so the
 *     hook can authenticate against the same probe data the runtime is
 *     about to act on).
 *   - The hook returns one of:
 *       `{ proceed: true }` — runtime executes the skill.
 *       `{ proceed: false, reason: string }` — runtime aborts before the
 *         skill runs and settles with verdict `aborted_by_hook`.
 *       `{ proceed: 'await-human', externalToken: string }` — runtime
 *         aborts in the same way; the token is recorded so an external
 *         confirmation system (signed approval, MFA challenge) can later
 *         resume the workflow out-of-band.
 *   - The hook may be sync or async. Throws are caught by the caller and
 *     surface as an aborted decision so an unhealthy hook can never let
 *     an irreversible action execute by accident.
 */

import type { Evidence } from '../../contracts/types.js';

/**
 * Input passed to the hook on every fire.
 *
 * `action` is a free-form operator-supplied label (e.g.
 * `"submit-checkout"`). The runtime does not interpret it — it is forwarded
 * as-is so the hook can drive policy lookups, audit log entries, or human-
 * facing confirmation prompts.
 *
 * `evidence` is the pre-condition `Evidence` block the runtime gathered
 * (when `contract.pre` is set and passed); `undefined` when the contract
 * has no precondition or the runtime never ran one.
 */
export interface BeforeIrreversibleHookInput {
  contractId: string;
  action: string;
  evidence?: Evidence;
}

/**
 * Decision returned by the hook.
 *
 *   - `{ proceed: true }` — runtime continues into the skill.
 *   - `{ proceed: false, reason }` — runtime aborts; `reason` is preserved
 *     verbatim on the resulting `TransactionRecord.error_message` so the
 *     audit log records why the irreversible action was blocked.
 *   - `{ proceed: 'await-human', externalToken }` — runtime aborts and
 *     records the token on the resulting record so an out-of-band system
 *     (signed approval, MFA challenge) can later resume the workflow.
 */
export type BeforeIrreversibleDecision =
  | { proceed: true }
  | { proceed: false; reason: string }
  | { proceed: 'await-human'; externalToken: string };

/** Operator hook signature. May be sync or async. */
export type BeforeIrreversibleHook = (
  input: BeforeIrreversibleHookInput,
) => BeforeIrreversibleDecision | Promise<BeforeIrreversibleDecision>;

/**
 * Default registered hook — a no-op pass-through. Always proceeds so the
 * pre-#795 (1.10.4) behavior is preserved when no operator has installed
 * a custom hook. Exported so callers (and the reset helper) can detect
 * the default vs an operator-installed instance via identity comparison.
 */
export const defaultBeforeIrreversibleHook: BeforeIrreversibleHook = () => ({
  proceed: true,
});

let registeredHook: BeforeIrreversibleHook = defaultBeforeIrreversibleHook;

/**
 * Register the operator's `beforeIrreversibleAction` hook. There is a
 * single registered hook at any time; calling this again replaces the
 * previously registered hook. A `console.error` warning is emitted on
 * replacement (but not when the default no-op is being replaced for the
 * first time) so operators that accidentally double-register can spot
 * the override during a smoke test.
 */
export function registerBeforeIrreversibleHook(hook: BeforeIrreversibleHook): void {
  if (registeredHook !== defaultBeforeIrreversibleHook) {
    // Use console.error per CLAUDE.md — console.log corrupts MCP JSON-RPC.
    console.error(
      '[pilot] beforeIrreversibleAction hook replaced; previously registered hook is no longer active',
    );
  }
  registeredHook = hook;
}

/**
 * Return the currently registered hook. Internal helper used by
 * `runWithContract()` so the hook can be swapped at runtime without the
 * runtime caching a stale reference.
 */
export function getBeforeIrreversibleHook(): BeforeIrreversibleHook {
  return registeredHook;
}

/**
 * Restore the default no-op hook. Intended for test setup / teardown so
 * tests do not leak hook state into one another.
 */
export function resetBeforeIrreversibleHookForTests(): void {
  registeredHook = defaultBeforeIrreversibleHook;
}
