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
  | 'graph_fallback_promoted'
  | 'graph_error';

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
 * consumers see a 1:1 correspondence between calls and events. If
 * `runSkillInner` rejects (snapshot, router, or storage failure), the
 * executor still emits a `graph_error` event with whatever progress was
 * captured before the throw, then re-raises so the caller's error
 * handling stays responsible for retry/abort.
 *
 * Audit emission is isolated from the run outcome: if the emitter itself
 * throws, the failure is swallowed and surfaced through `console.error`
 * so a logging or evidence-writer fault never reclassifies a successful
 * skill step as `graph_error`, and never masks a genuine inner exception.
 */
export async function runSkill(args: RunSkillArgs): Promise<RunSkillResult> {
  const { storage, router, ctx, intent } = args;
  const trace: ProgressTrace = {};
  let result: RunSkillResult | undefined;
  let innerError: unknown;
  // Separate boolean — `innerError` alone is ambiguous because callers can
  // legitimately throw `undefined` or do `Promise.reject()`. We must
  // re-raise any rejection, even one that carries no value.
  let didThrow = false;
  try {
    result = await runSkillInner({ storage, router, ctx, intent, trace });
  } catch (err) {
    innerError = err;
    didThrow = true;
  }

  if (args.audit) {
    try {
      const domain = args.domain ?? storage.domain;
      const { buildEventFromResult, buildEventFromError } = await import('./audit');
      const event = didThrow
        ? buildEventFromError(domain, innerError, trace)
        : buildEventFromResult(domain, result as RunSkillResult);
      args.audit.emit(event);
    } catch (emitErr) {
      // Telemetry failure is observability-only; don't poison the run.
      console.error('[skill] graph audit emit failed:', emitErr);
    }
  }

  if (didThrow) throw innerError;
  return result as RunSkillResult;
}

/** Captures partial progress so a thrown call can still produce an audit row. */
interface ProgressTrace {
  fromState?: string;
  toState?: string;
  action?: ActionInvocation;
}

async function runSkillInner(args: {
  storage: SkillGraphStorage;
  router: ToolRouter;
  ctx: ExecutionContext;
  intent: SkillIntent;
  trace: ProgressTrace;
}): Promise<RunSkillResult> {
  const { storage, router, ctx, intent, trace } = args;

  const before = await ctx.snapshotPageState();
  const fromHash = computeStateHash(before).hash;
  trace.fromState = fromHash;
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
      args: replayArgs(candidate),
    };
    trace.action = action;
    const result = await router.runAction(action);
    const after = await ctx.snapshotPageState();
    const toHash = computeStateHash(after).hash;
    trace.toState = toHash;
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
  trace.action = fallback;
  const fallbackResult = await router.runAction(fallback);
  const after = await ctx.snapshotPageState();
  const toHash = computeStateHash(after).hash;
  trace.toState = toHash;
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
      actionArgsReplay: encodeReplayArgs(fallback.args),
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

/**
 * Restore the structured args for a graph_hit replay.
 *
 * Prefers the lossless `actionArgsReplay` payload (recorded when the edge
 * was promoted from the fallback path). Falls back to parsing
 * `actionArgsNorm` for legacy edges captured before the v2 schema bump —
 * those edges may have non-JSON identities (e.g. `ref:*`), in which case
 * we surface the raw string to keep behaviour bug-compatible with v1.
 *
 * Exported for unit tests; the executor itself is the only production
 * caller.
 */
export function replayArgs(edge: SkillEdge): unknown {
  if (edge.actionArgsReplay !== undefined) {
    try {
      return JSON.parse(edge.actionArgsReplay);
    } catch {
      // Replay payload was corrupted — fall through to argsNorm so the
      // edge isn't unusable, but the caller will surface the action via
      // audit telemetry either way.
    }
  }
  try {
    return JSON.parse(edge.actionArgsNorm);
  } catch {
    return edge.actionArgsNorm;
  }
}

/**
 * Serialise the original action args into the lossless replay payload.
 * Returns undefined when the args don't survive a JSON round-trip (for
 * example, args containing functions or circular references). In that
 * case the edge is still promoted, but graph_hit replay falls back to
 * parsing `actionArgsNorm` — same behaviour as before this change.
 */
export function encodeReplayArgs(args: unknown): string | undefined {
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
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
