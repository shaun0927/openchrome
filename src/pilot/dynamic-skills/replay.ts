/**
 * Synthesized-tool replay handler (issue #889).
 *
 * When the MCP server dispatches a synthesized skill_<domain>__<skill>
 * tool call, this module is invoked. The replay path:
 *
 *   1. Resolves the current tab and reads its URL.
 *   2. Calls `assertDomainAllowed(currentUrl)` against the blocklist.
 *      A mismatch (or a blocked domain) returns the structured error
 *      `{ code: 'skill_domain_mismatch' }`.
 *   3. Replays the recorded action steps in declaration order. Step
 *      shapes recognised at this layer:
 *        - { kind: 'navigate', url }
 *        - { kind: 'fill', selector, valueParam }
 *        - { kind: 'click', selector }
 *        - { kind: 'wait', ms }
 *      Other step shapes are passed through unchanged — they are
 *      ignored by the deterministic replay engine, surfacing as a
 *      structured `skill_unsupported_step` error.
 *   4. Evaluates the skill's outcome contract as the post-condition.
 *      The post-condition runner is injected via `opts.assertContract`
 *      so tests can provide a deterministic verdict without booting
 *      the oc_assert pipeline.
 *
 * Returns `{ success: true, contract_id, evidence_handle? }` on
 * success. On contract miss, returns
 * `{ code: 'skill_postcondition_failed', evidence_handle? }`. On a
 * known-stale contract, returns `{ code: 'skill_stale' }`.
 *
 * Per portability-harness P3 (no outbound LLM call): replay performs
 * zero network I/O beyond what the recorded steps themselves drive
 * through the browser. No third-party HTTP, no LLM API.
 */

import { assertDomainAllowed, isDomainBlocked } from '../../security/domain-guard';
import type { SkillRecord } from '../../core/skill-memory';

import type { InterpretedSkillSteps } from './synthesizer';

/**
 * Outcome contract assertion outcome. The pilot contract runtime
 * (`src/pilot/runtime/`) emits richer verdicts, but for the synthesized
 * tool replay path we only need pass/fail plus an optional evidence
 * handle that callers can dereference via `oc_evidence_bundle`.
 */
export interface ContractAssertionVerdict {
  readonly pass: boolean;
  /**
   * Optional opaque handle the caller can pass to oc_evidence_bundle
   * for a deep inspection of the failed post-condition. The replay
   * handler is intentionally agnostic of the handle format.
   */
  readonly evidenceHandle?: string;
  /**
   * Optional structured reason. The handler folds this into the
   * `skill_postcondition_failed` error payload when present.
   */
  readonly reason?: string;
  /**
   * Optional flag from the contract runtime indicating the contract is
   * known-failing for this domain (e.g., login form moved). Returning
   * `stale: true` short-circuits to `{ code: 'skill_stale' }` rather
   * than `skill_postcondition_failed`.
   */
  readonly stale?: boolean;
}

/**
 * Resolution result for the current tab the replay should operate on.
 * The pilot bootstrap injects a resolver so the replay handler does
 * not import session-manager primitives directly (tests pass a fake).
 */
export interface CurrentTabInfo {
  /** Live URL of the tab. */
  readonly url: string;
  /** Tab id, for downstream calls into the action runner. */
  readonly tabId: string;
}

/**
 * Per-step result returned by the action runner. The runner is
 * pluggable so the actual browser-driving glue lives outside this
 * module — `replay.ts` only orchestrates the sequence.
 */
export interface ActionStepResult {
  readonly ok: boolean;
  /** Structured error code when ok=false. */
  readonly code?: string;
  /** Human-readable diagnostic when ok=false. */
  readonly message?: string;
}

/**
 * Dispatchable action step (subset the replay handler interprets).
 * Anything outside this discriminated union is rejected before the
 * action runner sees it.
 */
export type ReplayActionStep =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'fill'; readonly selector: string; readonly valueParam: string }
  | { readonly kind: 'click'; readonly selector: string }
  | { readonly kind: 'wait'; readonly ms: number }
  | { readonly kind: 'wait_for'; readonly selector: string; readonly timeout_ms?: number };

export interface ReplayHandlerOpts {
  /**
   * Resolve the tab the replay should target. The MCP session id of the
   * caller is passed so the resolver can scope its tab lookup to that
   * session — otherwise concurrent agents would all share whatever tab the
   * default session happens to have open (Codex P1 on PR #930).
   */
  resolveCurrentTab: (sessionId: string) => Promise<CurrentTabInfo | null>;
  /**
   * Drive one recorded step in the browser. The caller's session id is
   * forwarded so the runner can fetch the target page from the correct
   * session (Codex P1 follow-up on PR #930 — same scope as the resolver).
   */
  runStep: (
    tab: CurrentTabInfo,
    step: ReplayActionStep,
    args: Record<string, unknown>,
    sessionId: string,
  ) => Promise<ActionStepResult>;
  /**
   * Evaluate the skill's outcome contract. The caller's session id is
   * forwarded so the assertion can run inside the same Chrome target the
   * replay just acted on (also Codex P1 on PR #930).
   */
  assertContract: (
    skill: SkillRecord,
    tab: CurrentTabInfo,
    sessionId: string,
  ) => Promise<ContractAssertionVerdict>;
}

/** Discriminated structured response from `runReplay()`. */
export type ReplayResult =
  | {
      readonly success: true;
      readonly contract_id: string;
      readonly evidence_handle?: string;
    }
  | {
      readonly success: false;
      readonly code: ReplayErrorCode;
      readonly message?: string;
      readonly evidence_handle?: string;
      readonly step_index?: number;
    };

export type ReplayErrorCode =
  | 'skill_domain_mismatch'
  | 'skill_stale'
  | 'skill_postcondition_failed'
  | 'skill_no_active_tab'
  | 'skill_unsupported_step'
  | 'skill_step_failed'
  | 'skill_invalid_steps';

/**
 * Parse the discriminated union out of the skill's `steps` blob. Only
 * shapes from {@link ReplayActionStep} are accepted — other entries
 * yield `null` so the caller can short-circuit with
 * `skill_unsupported_step`.
 */
function coerceStep(raw: Record<string, unknown>): ReplayActionStep | null {
  const kind = raw.kind;
  if (kind === 'navigate' && typeof raw.url === 'string' && raw.url.length > 0) {
    return { kind: 'navigate', url: raw.url };
  }
  if (
    kind === 'fill' &&
    typeof raw.selector === 'string' &&
    raw.selector.length > 0 &&
    typeof raw.valueParam === 'string' &&
    raw.valueParam.length > 0
  ) {
    return { kind: 'fill', selector: raw.selector, valueParam: raw.valueParam };
  }
  if (kind === 'click' && typeof raw.selector === 'string' && raw.selector.length > 0) {
    return { kind: 'click', selector: raw.selector };
  }
  if (kind === 'wait' && typeof raw.ms === 'number' && Number.isFinite(raw.ms) && raw.ms >= 0) {
    return { kind: 'wait', ms: raw.ms };
  }
  if (kind === 'wait_for' && typeof raw.selector === 'string' && raw.selector.length > 0) {
    return {
      kind: 'wait_for',
      selector: raw.selector,
      timeout_ms:
        typeof raw.timeout_ms === 'number' && Number.isFinite(raw.timeout_ms) && raw.timeout_ms >= 0
          ? raw.timeout_ms
          : undefined,
    };
  }
  return null;
}

/**
 * Extract the `actions` array out of the skill's recorded steps. The
 * synthesizer documents the same convention — keeping the parser
 * here means a missing `actions` field surfaces as a typed result
 * (rather than silently no-oping in the runner).
 */
function extractActions(steps: unknown): Record<string, unknown>[] | null {
  // `oc_skill_record` stores `steps` as a top-level array, while the
  // synthesizer convention (and several test fixtures) wrap them in
  // `{ parameters, actions }`. Accept both shapes — anything else
  // surfaces as the typed `skill_invalid_steps` error.
  const actions = Array.isArray(steps)
    ? steps
    : steps && typeof steps === 'object'
      ? (steps as InterpretedSkillSteps).actions
      : null;
  if (!Array.isArray(actions)) return null;
  const filtered: Record<string, unknown>[] = [];
  for (const entry of actions) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      filtered.push(entry as Record<string, unknown>);
    }
  }
  return filtered;
}

/**
 * Extract the eTLD+1-ish hostname from a URL. We delegate the
 * blocklist check itself to `assertDomainAllowed`, but we need the
 * hostname for the domain-vs-skill mismatch comparison and that check
 * lives here so the replay handler is the single source of truth for
 * the structured `skill_domain_mismatch` code.
 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Drive one skill replay. The handler is pure-ish — every side effect
 * (browser action, contract evaluation, tab resolution) is supplied
 * by the caller through `opts`. That keeps `replay.ts` deterministic
 * under unit test (the tests inject fakes) while production wires it
 * up against the real session manager + contract runtime.
 */
export async function runReplay(
  skill: SkillRecord,
  args: Record<string, unknown>,
  opts: ReplayHandlerOpts,
  sessionId: string,
): Promise<ReplayResult> {
  // Step 0: resolve the current tab. Without one we cannot enforce
  // the domain check, so refuse early.
  const tab = await opts.resolveCurrentTab(sessionId);
  if (!tab) {
    return { success: false, code: 'skill_no_active_tab', message: 'no active tab to replay against' };
  }

  // Step 1: domain-vs-skill comparison + blocklist guard. Use both
  // axes — an attacker who somehow got a synthesized tool registered
  // for a blocked domain still gets refused at replay time.
  const currentHost = hostnameOf(tab.url);
  const skillHost = skill.domain.toLowerCase();
  if (!currentHost || currentHost !== skillHost) {
    return {
      success: false,
      code: 'skill_domain_mismatch',
      message: `current tab host "${currentHost}" does not match skill domain "${skillHost}"`,
    };
  }
  try {
    assertDomainAllowed(tab.url);
  } catch (err) {
    return {
      success: false,
      code: 'skill_domain_mismatch',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  // Belt-and-suspenders: if the policy was updated mid-session and
  // assertDomainAllowed somehow did not throw (e.g., a corner case in
  // pattern matching), the explicit isDomainBlocked check still
  // catches it. Both axes converge on the same error code so callers
  // do not need to branch.
  if (isDomainBlocked(tab.url)) {
    return {
      success: false,
      code: 'skill_domain_mismatch',
      message: `domain "${currentHost}" is on the blocklist`,
    };
  }

  // Step 2: parse & validate the recorded action sequence.
  const rawActions = extractActions(skill.steps);
  if (rawActions === null) {
    return {
      success: false,
      code: 'skill_invalid_steps',
      message: 'skill.steps is missing or has no `actions` array',
    };
  }
  const steps: ReplayActionStep[] = [];
  for (let i = 0; i < rawActions.length; i++) {
    const coerced = coerceStep(rawActions[i]);
    if (coerced === null) {
      return {
        success: false,
        code: 'skill_unsupported_step',
        message: `step #${i} kind=${String(rawActions[i].kind)} is not a recognised replay step`,
        step_index: i,
      };
    }
    steps.push(coerced);
  }

  // Step 3: drive each step sequentially. We deliberately do not
  // parallelise — replay must preserve recorded order.
  for (let i = 0; i < steps.length; i++) {
    const result = await opts.runStep(tab, steps[i], args, sessionId);
    if (!result.ok) {
      return {
        success: false,
        code: 'skill_step_failed',
        message: result.message ?? result.code ?? `step #${i} failed`,
        step_index: i,
      };
    }
  }

  // Step 4: post-condition. The contract runtime owns the verdict
  // shape — we just forward the structured outcome.
  const verdict = await opts.assertContract(skill, tab, sessionId);
  if (verdict.stale === true) {
    return {
      success: false,
      code: 'skill_stale',
      message: verdict.reason ?? 'contract is known-failing for this domain',
      ...(verdict.evidenceHandle !== undefined && { evidence_handle: verdict.evidenceHandle }),
    };
  }
  if (!verdict.pass) {
    return {
      success: false,
      code: 'skill_postcondition_failed',
      message: verdict.reason ?? 'outcome contract did not pass',
      ...(verdict.evidenceHandle !== undefined && { evidence_handle: verdict.evidenceHandle }),
    };
  }

  return {
    success: true,
    contract_id: skill.contractId,
    ...(verdict.evidenceHandle !== undefined && { evidence_handle: verdict.evidenceHandle }),
  };
}
