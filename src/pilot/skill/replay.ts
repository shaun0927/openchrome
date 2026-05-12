/**
 * Pilot-tier deterministic skill replay (#856).
 *
 * Walks a recorded skill's `steps[]` and re-executes each step against an
 * injected CDP client. Optionally awaits `Page.frameNavigated` between
 * steps when the recorded step asks for it. No LLM calls, no DOM
 * heuristics, no retries — failure aborts replay immediately and records
 * the outcome via `SkillMemoryStore.recordReplayResult()`.
 *
 * Cross-origin precondition gate (issue #856 invariant #2): if the
 * skill's `frozen_snapshot.url_origin` does not match the active tab's
 * origin, the runner refuses to execute any step and returns
 * `outcome: 'PRECONDITION_FAIL'`.
 *
 * Per portability-harness contract:
 *   P3 — no outbound LLM (this module never calls a model)
 *   P4 — deterministic core/pilot path (no retries, no heuristics)
 *   P5 — no new native deps (pure TS over the existing CDP client)
 *
 * The module is intentionally side-effect free at import time: it only
 * exposes types and a pure `runReplay()` function. The MCP tool wrapper
 * (`src/tools/oc-skill-replay.ts`) is responsible for injecting the
 * concrete CDP client, snapshot reader, and trace emitter.
 */

import type { SkillRecord, SkillMemoryStore } from '../../core/skill-memory';

/**
 * Recorded step shape consumed by replay. The store persists `steps[]` as
 * `unknown`; we narrow at the replay boundary and treat any deviation as
 * a hard step failure so an upstream recorder change cannot silently
 * corrupt replays.
 */
export interface RecordedStep {
  /** Verbatim CDP method, e.g. `Input.dispatchMouseEvent`. */
  method: string;
  /** Verbatim params passed to `cdp.send`. */
  params?: Record<string, unknown>;
  /**
   * When true, the runner awaits one `Page.frameNavigated` event after
   * the step completes (with `step_timeout_ms` as the upper bound).
   * Defaults to false.
   */
  awaitFrameNavigated?: boolean;
}

export type ReplayOutcome =
  | 'PASS'
  | 'STEP_FAIL'
  | 'CONTRACT_FAIL'
  | 'PRECONDITION_FAIL';

export interface ReplayStepFailure {
  index: number;
  error: string;
}

export interface ReplayContractVerdict {
  evaluated: boolean;
  passed: boolean;
  /** Shape mirrors `oc_assert`'s output verbatim. */
  detail?: unknown;
}

export interface SkillReplayResult {
  skill_id: string;
  contract_id: string | null;
  steps_total: number;
  steps_executed: number;
  step_failures: ReplayStepFailure[];
  contract: ReplayContractVerdict;
  outcome: ReplayOutcome;
  duration_ms: number;
}

/**
 * Minimal CDP surface consumed by replay. Mirrors `CDPClient.send` (see
 * `src/cdp/client.ts`) without dragging the whole client type into the
 * pilot tier — the tool wrapper adapts the real client to this shape.
 */
export interface ReplayCdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /**
   * Returns the active tab's URL. The runner uses it to derive the
   * origin for the precondition gate. May return `null` / empty if no
   * tab is active.
   */
  getActiveUrl(): Promise<string | null>;
  /**
   * Awaits one `Page.frameNavigated` event within `timeoutMs`. Resolves
   * when the navigation fires; rejects on timeout. Optional — the runner
   * skips frame-navigation awaits when the function is omitted.
   */
  awaitFrameNavigated?: (timeoutMs: number) => Promise<void>;
}

/**
 * Snapshot reader used to fetch the recorded `url_origin` for the
 * cross-origin precondition gate. Returning `null` is treated as "no
 * snapshot recorded" — replay still proceeds but the gate is skipped,
 * matching the issue's "fixture skill recorded on … replay attempted
 * while on …" precondition (only triggers when a snapshot has an origin).
 */
export interface FrozenSnapshotReader {
  readUrlOrigin(skill: SkillRecord): Promise<string | null>;
}

/**
 * Contract evaluator hook. The MCP tool wrapper plumbs `oc_assert`
 * through this surface; the replay module never imports `oc_assert`
 * directly so the pilot module stays decoupled from MCP plumbing.
 */
export interface ContractEvaluator {
  /**
   * Evaluate `contract_id` (or whatever is bound to the skill) against
   * the current live page state. Returns `passed: false` on any failure;
   * `evaluated: false` only when the evaluator could not run at all.
   */
  evaluate(args: {
    skill: SkillRecord;
    contractId: string;
  }): Promise<ReplayContractVerdict>;
}

/** Synthetic trace event emitted once per replay. Schema is invariant #6. */
export interface ReplayTraceEvent {
  kind: 'skill_replay';
  skill_id: string;
  outcome: ReplayOutcome;
  contract_id: string | null;
  steps_total: number;
  steps_executed: number;
  duration_ms: number;
}

/** Trace emitter contract — no-op when no session is active. */
export interface ReplayTraceEmitter {
  emit(event: ReplayTraceEvent): Promise<void> | void;
}

export const DEFAULT_STEP_TIMEOUT_MS = 5000;
export const MAX_STEP_TIMEOUT_MS = 30000;

export interface RunReplayArgs {
  skillId: string;
  contractId?: string;
  stepTimeoutMs?: number;
  store: SkillMemoryStore;
  cdp: ReplayCdpClient;
  snapshotReader: FrozenSnapshotReader;
  evaluator: ContractEvaluator;
  trace?: ReplayTraceEmitter;
  /** Injected for deterministic test timestamps. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Parse a URL string into its origin (`<scheme>://<host>[:<port>]`).
 * Returns `null` for malformed / opaque values so the precondition gate
 * can degrade gracefully — the issue treats only "snapshot has origin,
 * tab has origin, they differ" as a hard PRECONDITION_FAIL.
 */
function parseOrigin(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const u = new URL(url);
    if (!u.protocol || u.origin === 'null') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Validate a single recorded step at the replay boundary. */
function narrowStep(raw: unknown, index: number): RecordedStep | string {
  if (raw === null || typeof raw !== 'object') {
    return `step ${index}: not an object`;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.method !== 'string' || obj.method.length === 0) {
    return `step ${index}: missing string field "method"`;
  }
  if (obj.params !== undefined && (obj.params === null || typeof obj.params !== 'object')) {
    return `step ${index}: "params" must be an object when provided`;
  }
  if (obj.awaitFrameNavigated !== undefined && typeof obj.awaitFrameNavigated !== 'boolean') {
    return `step ${index}: "awaitFrameNavigated" must be a boolean when provided`;
  }
  return {
    method: obj.method,
    params: (obj.params as Record<string, unknown> | undefined) ?? undefined,
    awaitFrameNavigated: Boolean(obj.awaitFrameNavigated),
  };
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function clampTimeout(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_STEP_TIMEOUT_MS;
  if (raw <= 0) return DEFAULT_STEP_TIMEOUT_MS;
  return Math.min(MAX_STEP_TIMEOUT_MS, Math.floor(raw));
}

/**
 * Run a recorded skill end-to-end. See `SkillReplayResult` for the
 * outcome semantics; this function never throws — every failure path
 * surfaces through the result's `outcome` field plus a `recordReplayResult`
 * write to the skill store.
 *
 * Trace emission (#856 invariant #6) happens after `recordReplayResult`
 * but before returning, so a synchronous test runner can assert against
 * the persisted JSONL once `runReplay` resolves.
 */
export async function runReplay(args: RunReplayArgs): Promise<SkillReplayResult> {
  const now = args.now ?? (() => Date.now());
  const t0 = now();

  const stepTimeoutMs = clampTimeout(args.stepTimeoutMs);
  const skill = args.store.get(args.skillId);

  const baseResult: Omit<SkillReplayResult, 'outcome' | 'duration_ms'> = {
    skill_id: args.skillId,
    contract_id: null,
    steps_total: 0,
    steps_executed: 0,
    step_failures: [],
    contract: { evaluated: false, passed: false },
  };

  const finish = async (
    outcome: ReplayOutcome,
    partial: Partial<SkillReplayResult>,
    err?: string,
  ): Promise<SkillReplayResult> => {
    const result: SkillReplayResult = {
      ...baseResult,
      ...partial,
      outcome,
      duration_ms: Math.max(0, now() - t0),
    };
    // Persist the replay outcome. Best-effort: a store-write failure
    // must not turn a PASS into a STEP_FAIL, so we swallow errors here
    // and log to stderr.
    if (skill !== null) {
      try {
        if (outcome === 'PASS') {
          await args.store.recordReplayResult(args.skillId, { passedAt: now() });
        } else {
          await args.store.recordReplayResult(args.skillId, {
            failedAt: now(),
            error: err,
          });
        }
      } catch (storeErr) {
        const msg = storeErr instanceof Error ? storeErr.message : String(storeErr);
        console.error(`[skill-replay] recordReplayResult failed: ${msg}`);
      }
    }
    // Emit the trace event last so a downstream assertion can read both
    // the store and the trace deterministically.
    if (args.trace) {
      try {
        await args.trace.emit({
          kind: 'skill_replay',
          skill_id: args.skillId,
          outcome: result.outcome,
          contract_id: result.contract_id,
          steps_total: result.steps_total,
          steps_executed: result.steps_executed,
          duration_ms: result.duration_ms,
        });
      } catch (traceErr) {
        const msg = traceErr instanceof Error ? traceErr.message : String(traceErr);
        console.error(`[skill-replay] trace emit failed: ${msg}`);
      }
    }
    return result;
  };

  if (skill === null) {
    return finish(
      'STEP_FAIL',
      { ...baseResult, step_failures: [{ index: -1, error: 'unknown skill_id' }] },
      'unknown skill_id',
    );
  }

  const contractId = args.contractId ?? skill.contractId ?? null;

  // ── Precondition gate (invariant #2) ───────────────────────────────
  let snapshotOrigin: string | null = null;
  let snapshotReadError: string | null = null;
  try {
    snapshotOrigin = await args.snapshotReader.readUrlOrigin(skill);
  } catch (e) {
    // Fail closed: when the skill promises a frozen snapshot path but the
    // reader threw, we cannot verify the cross-origin precondition. Record
    // the error so the gate below can short-circuit to STEP_FAIL instead of
    // silently treating the read failure as "no origin recorded" (Codex P1
    // on PR #928 — fail-open hole).
    snapshotReadError = e instanceof Error ? e.message : String(e);
    console.error(`[skill-replay] snapshot read failed: ${snapshotReadError}`);
  }
  if (snapshotReadError !== null && skill.frozenSnapshotPath) {
    const stepsTotal = Array.isArray(skill.steps) ? skill.steps.length : 0;
    const err = `origin_check_failed: snapshot read failed (${snapshotReadError})`;
    return finish(
      'STEP_FAIL',
      {
        contract_id: contractId,
        steps_total: stepsTotal,
        steps_executed: 0,
        step_failures: [{ index: -1, error: err }],
      },
      err,
    );
  }
  if (snapshotOrigin !== null) {
    let activeUrl: string | null = null;
    let activeUrlError: string | null = null;
    try {
      activeUrl = await args.cdp.getActiveUrl();
    } catch (e) {
      activeUrlError = e instanceof Error ? e.message : String(e);
      console.error(`[skill-replay] getActiveUrl failed: ${activeUrlError}`);
    }
    // Fail closed: when the snapshot origin is known but the active URL
    // cannot be retrieved (either threw or returned a non-parseable value),
    // we cannot verify the precondition gate. Returning STEP_FAIL avoids
    // a silent fail-open. See Gemini review on PR #928.
    const activeOrigin = parseOrigin(activeUrl);
    if (activeOrigin === null) {
      const stepsTotal = Array.isArray(skill.steps) ? skill.steps.length : 0;
      const err = activeUrlError
        ? `origin_check_failed: ${activeUrlError}`
        : 'origin_check_failed';
      return finish(
        'STEP_FAIL',
        {
          contract_id: contractId,
          steps_total: stepsTotal,
          steps_executed: 0,
          step_failures: [{ index: -1, error: err }],
        },
        err,
      );
    }
    if (activeOrigin !== snapshotOrigin) {
      const err = `precondition: snapshot origin "${snapshotOrigin}" does not match active origin "${activeOrigin}"`;
      const stepsTotal = Array.isArray(skill.steps) ? skill.steps.length : 0;
      return finish(
        'PRECONDITION_FAIL',
        {
          contract_id: contractId,
          steps_total: stepsTotal,
          steps_executed: 0,
          step_failures: [{ index: -1, error: err }],
        },
        err,
      );
    }
  }

  // ── Step replay ────────────────────────────────────────────────────
  if (!Array.isArray(skill.steps)) {
    const err = 'skill.steps is not an array';
    return finish(
      'STEP_FAIL',
      {
        contract_id: contractId,
        steps_total: 0,
        step_failures: [{ index: -1, error: err }],
      },
      err,
    );
  }

  const steps = skill.steps as unknown[];
  const stepsTotal = steps.length;
  let stepsExecuted = 0;
  const stepFailures: ReplayStepFailure[] = [];

  for (let i = 0; i < steps.length; i++) {
    const narrowed = narrowStep(steps[i], i);
    if (typeof narrowed === 'string') {
      stepFailures.push({ index: i, error: narrowed });
      return finish(
        'STEP_FAIL',
        {
          contract_id: contractId,
          steps_total: stepsTotal,
          steps_executed: stepsExecuted,
          step_failures: stepFailures,
        },
        narrowed,
      );
    }
    try {
      // Arm the frame-navigation waiter BEFORE dispatching the CDP step.
      // page.waitForNavigation() (under the cdp adapter) attaches its listener
      // synchronously when called, but the navigation it's waiting for may
      // start during the very next tick after our send() resolves. If we
      // attached the waiter after the send, a fast click/submit could navigate
      // before the listener was installed and the wait would time out even
      // though the step succeeded (Codex P1 on PR #928 fixup).
      const navWait =
        narrowed.awaitFrameNavigated && args.cdp.awaitFrameNavigated
          ? args.cdp.awaitFrameNavigated(stepTimeoutMs)
          : null;
      // Swallow the pending rejection until we explicitly await it below; this
      // is only needed to silence "unhandled rejection" reports during the
      // send() phase. The real rejection still surfaces from the awaited
      // withTimeout() call.
      if (navWait) navWait.catch(() => {});
      await withTimeout(
        args.cdp.send(narrowed.method, narrowed.params),
        stepTimeoutMs,
        `cdp ${narrowed.method}`,
      );
      if (navWait) {
        await withTimeout(navWait, stepTimeoutMs, 'Page.frameNavigated');
      }
      stepsExecuted++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      stepFailures.push({ index: i, error: msg });
      return finish(
        'STEP_FAIL',
        {
          contract_id: contractId,
          steps_total: stepsTotal,
          steps_executed: stepsExecuted,
          step_failures: stepFailures,
        },
        msg,
      );
    }
  }

  // ── Contract gate ──────────────────────────────────────────────────
  if (contractId === null || contractId.length === 0) {
    // No contract bound — by invariant #1, PASS requires an evaluated
    // contract. Surface as CONTRACT_FAIL with evaluated=false.
    const err = 'no contract bound to skill';
    return finish(
      'CONTRACT_FAIL',
      {
        contract_id: contractId,
        steps_total: stepsTotal,
        steps_executed: stepsExecuted,
        contract: { evaluated: false, passed: false },
      },
      err,
    );
  }

  let verdict: ReplayContractVerdict;
  try {
    verdict = await args.evaluator.evaluate({ skill, contractId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return finish(
      'CONTRACT_FAIL',
      {
        contract_id: contractId,
        steps_total: stepsTotal,
        steps_executed: stepsExecuted,
        contract: { evaluated: false, passed: false, detail: { error: msg } },
      },
      msg,
    );
  }

  if (!verdict.evaluated || !verdict.passed) {
    const err = !verdict.evaluated ? 'contract did not evaluate' : 'contract failed';
    return finish(
      'CONTRACT_FAIL',
      {
        contract_id: contractId,
        steps_total: stepsTotal,
        steps_executed: stepsExecuted,
        contract: verdict,
      },
      err,
    );
  }

  return finish('PASS', {
    contract_id: contractId,
    steps_total: stepsTotal,
    steps_executed: stepsExecuted,
    contract: verdict,
  });
}
