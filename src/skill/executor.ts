/**
 * Graph-aware skill executor.
 *
 * Replaces the old "always-restart" pattern with state-aware resume:
 *   1. Snapshot the page → compute the current state hash (#702).
 *   2. Look up the node in the per-domain skill graph (#702 storage).
 *   3. Pick the highest-success-rate outgoing edge that matches `intent`.
 *   4. Execute the action via the tool-router adapter (existing src/tools/*).
 *   5. Re-snapshot, compute new hash, validate against the edge's
 *      `to_state_distribution` per #703 v2 rules.
 *   6. Record the outcome (success/fail, observed to_state).
 *   7. If no edge matches in step 3, fall back to the existing waterfall
 *      and *promote* the observed transition into the graph as a new edge.
 *
 * The router is injected so tests can mock it (the real adapter wiring
 * to `src/tools/` lives in PR-7).
 */

import { computeStateHash, type PageSnapshot } from './state';
import {
  SkillGraphStorage,
  type SkillEdge,
  type ToStateDistribution,
} from './storage';

/** A single action the router can execute. */
export interface ActionInvocation {
  /** Action kind: `click`, `type`, `navigate`, etc. */
  kind: string;
  /** Canonical args representation used for graph identity. */
  argsNorm: string;
  /** Raw args passed to the underlying tool. */
  args: unknown;
}

export interface ActionResult {
  ok: boolean;
  /** Optional reason for failure — surfaced in audit + telemetry. */
  reason?: string;
}

/**
 * Context the executor needs from its host. Hosts (PR-7's MCP layer)
 * supply real puppeteer-driven snapshotters; tests supply fakes.
 */
export interface ExecutionContext {
  /** Capture the current page state. Called before and after each action. */
  snapshotPageState(): Promise<PageSnapshot>;
}

/** Tool dispatcher abstraction — adapter to existing src/tools/* in PR-7. */
export interface ToolRouter {
  /**
   * Pick a best action for the current snapshot + intent, without using
   * the graph. Used as the fallback path when the graph has no edge.
   */
  pickFallbackAction(snapshot: PageSnapshot, intent: SkillIntent): Promise<ActionInvocation | null>;
  /** Execute the action; returns ok/fail. */
  runAction(action: ActionInvocation): Promise<ActionResult>;
}

export interface SkillIntent {
  /** Human-readable description (logging only). */
  description?: string;
  /** Restrict edge selection to these action kinds. */
  allowedKinds?: string[];
}

export type RunOutcomeKind =
  | 'graph_hit'
  | 'graph_miss'
  | 'graph_fallback_promoted';

export interface RunSkillResult {
  outcome: RunOutcomeKind;
  fromState: string;
  toState?: string;
  /** The action invocation that was executed (if any). */
  action?: ActionInvocation;
  ok: boolean;
  /** Failure reason or "expected_state_mismatch" / "no_action_available". */
  reason?: string;
  /** True when the new hash matched the edge's expected distribution. */
  matchedExpected?: boolean;
}

export interface RunSkillArgs {
  storage: SkillGraphStorage;
  router: ToolRouter;
  ctx: ExecutionContext;
  intent: SkillIntent;
  /**
   * Optional audit emitter — when supplied, the executor emits one
   * `GraphAuditEvent` per call (graph_hit / graph_miss /
   * graph_fallback_promoted). Hosts wire this to the audit-logger
   * pipeline; tests can substitute a fake to assert on emissions.
   */
  audit?: { emit(event: import('./audit').GraphAuditEvent): void };
  /**
   * Domain label for audit events. Defaults to `storage.domain`.
   */
  domain?: string;
}

/** Threshold per #703 v2: 10% of total invocations. */
const DISTRIBUTION_MATCH_THRESHOLD = 0.1;
/** Below this total invocation count, fall back to the looser rule. */
const SMALL_SAMPLE_TOTAL = 10;

/**
 * One pass of skill execution. Hosts call this in a loop (or once per
 * intent step, depending on skill granularity).
 *
 * When `args.audit` is supplied, exactly one event is emitted before
 * return — even on the early "no_action_available" path — so audit
 * consumers see a 1:1 correspondence between calls and events.
 */
export async function runSkill(args: RunSkillArgs): Promise<RunSkillResult> {
  const { storage, router, ctx, intent } = args;
  const result = await runSkillInner({ storage, router, ctx, intent });
  if (args.audit) {
    const { buildEventFromResult } = await import('./audit');
    args.audit.emit(buildEventFromResult(args.domain ?? storage.domain, result));
  }
  return result;
}

async function runSkillInner(args: {
  storage: SkillGraphStorage;
  router: ToolRouter;
  ctx: ExecutionContext;
  intent: SkillIntent;
}): Promise<RunSkillResult> {
  const { storage, router, ctx, intent } = args;

  const before = await ctx.snapshotPageState();
  const fromHash = computeStateHash(before).hash;
  storage.upsertNode({
    stateHash: fromHash,
    evidence: computeStateHash(before).evidence,
  });

  const candidate = pickBestEdge(storage.edgesFrom(fromHash), intent);

  // Path A — graph hit
  if (candidate) {
    const action: ActionInvocation = {
      kind: candidate.actionKind,
      argsNorm: candidate.actionArgsNorm,
      args: parseArgs(candidate.actionArgsNorm),
    };
    const result = await router.runAction(action);
    const after = await ctx.snapshotPageState();
    const toHash = computeStateHash(after).hash;
    storage.upsertNode({
      stateHash: toHash,
      evidence: computeStateHash(after).evidence,
    });
    const matched = result.ok && matchesExpected(toHash, candidate);
    storage.recordOutcome({
      fromState: fromHash,
      actionKind: action.kind,
      actionArgsNorm: action.argsNorm,
      observedToState: toHash,
      success: matched,
    });
    return {
      outcome: 'graph_hit',
      fromState: fromHash,
      toState: toHash,
      action,
      ok: matched,
      matchedExpected: matched,
      reason: result.ok && !matched ? 'expected_state_mismatch' : result.reason,
    };
  }

  // Path B — graph miss → fallback
  const fallback = await router.pickFallbackAction(before, intent);
  if (!fallback) {
    return {
      outcome: 'graph_miss',
      fromState: fromHash,
      ok: false,
      reason: 'no_action_available',
    };
  }
  const fallbackResult = await router.runAction(fallback);
  const after = await ctx.snapshotPageState();
  const toHash = computeStateHash(after).hash;
  storage.upsertNode({
    stateHash: toHash,
    evidence: computeStateHash(after).evidence,
  });

  // Promote the observed transition to the graph (only on success — failed
  // edges contaminate the graph if we add them blindly).
  if (fallbackResult.ok) {
    storage.recordOutcome({
      fromState: fromHash,
      actionKind: fallback.kind,
      actionArgsNorm: fallback.argsNorm,
      observedToState: toHash,
      success: true,
    });
    return {
      outcome: 'graph_fallback_promoted',
      fromState: fromHash,
      toState: toHash,
      action: fallback,
      ok: true,
      matchedExpected: undefined,
    };
  }

  // Fallback ran but failed — record as fail without promoting a "preferred"
  // path. We still create the edge row so future runs see the negative
  // signal, but with an empty observed_to_state (failure is the only datum).
  storage.recordOutcome({
    fromState: fromHash,
    actionKind: fallback.kind,
    actionArgsNorm: fallback.argsNorm,
    success: false,
  });
  return {
    outcome: 'graph_miss',
    fromState: fromHash,
    toState: toHash,
    action: fallback,
    ok: false,
    reason: fallbackResult.reason ?? 'fallback_action_failed',
  };
}

/**
 * Pick the highest-success-rate edge consistent with `intent`. Edges with
 * disallowed kinds are skipped. `edgesFrom` already returns sorted by rate.
 */
export function pickBestEdge(edges: SkillEdge[], intent: SkillIntent): SkillEdge | undefined {
  const allowed = intent.allowedKinds && intent.allowedKinds.length > 0
    ? new Set(intent.allowedKinds)
    : undefined;
  for (const edge of edges) {
    if (allowed && !allowed.has(edge.actionKind)) continue;
    return edge;
  }
  return undefined;
}

/**
 * Match a new hash against the edge's recorded distribution per #703 v2:
 *
 *   total = sum of distribution counts
 *   if total < 10:
 *     matched = (newHash in distribution AT ANY COUNT) OR
 *               (newHash absent AND fail_count == 0)   // first observation
 *   else:
 *     matched = count[newHash] / total ≥ 0.10
 */
export function matchesExpected(newHash: string, edge: SkillEdge): boolean {
  const dist = edge.toStateDistribution;
  const total = dist.reduce((sum: number, e) => sum + e.count, 0);
  const entry = dist.find((e) => e.to_state === newHash);

  if (total < SMALL_SAMPLE_TOTAL) {
    if (entry) return true;
    // Absent + no failures yet ⇒ this is a fresh observation, accept it
    return edge.failCount === 0;
  }

  if (!entry) return false;
  return entry.count / total >= DISTRIBUTION_MATCH_THRESHOLD;
}

/** Best-effort decode of canonical args. Falls back to the raw string. */
function parseArgs(argsNorm: string): unknown {
  try {
    return JSON.parse(argsNorm);
  } catch {
    return argsNorm;
  }
}

/** Test-internal helper for `to_state_distribution` math without an SkillEdge. */
export function _matchesExpectedRaw(
  newHash: string,
  dist: ToStateDistribution,
  failCount: number,
): boolean {
  return matchesExpected(newHash, {
    fromState: '',
    actionKind: '',
    actionArgsNorm: '',
    toStateDistribution: dist,
    successCount: 0,
    failCount,
  });
}
