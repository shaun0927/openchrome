/**
 * oc_skill_replay — deterministic selector-chain replay for skill memory (#875).
 *
 * Core-tier MCP tool. Loads a previously-recorded skill by `skill_id`, walks
 * its per-step `replay_artifact` entries, and re-issues each action against
 * the live page **without any LLM round-trip**. Each step's selector list is
 * tried in declaration order; first successful resolution wins.
 *
 * Per the portability-harness contract:
 *   - P1: no orchestration beyond the persisted step list.
 *   - P3: no outbound HTTP / no LLM API.
 *   - P4: facts, not decisions — failures return a structured envelope; the
 *     host chooses the fallback.
 *
 * The tool NEVER throws. Every error path returns `{ ok: false, failure: {...} }`.
 * When the `OPENCHROME_SKILL_REPLAY` env var is `0`/`false`, the tool still
 * surfaces in `tools/list` (P2 schema parity) but every invocation returns
 * `{ ok: false, failure: { code: 'DISABLED' } }`.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import {
  SkillMemoryStore,
  validateReplayArtifact,
  type ReplayArtifactStep,
  type ReplaySelector,
  type SkillRecord,
} from '../core/skill-memory';
import { isCoreFeatureEnabled } from '../harness/flags';

/** Default per-step budget. Matches the existing 5s timeout pattern used in pilot. */
const DEFAULT_STEP_TIMEOUT_MS = 5000;
const MIN_STEP_TIMEOUT_MS = 100;
const MAX_STEP_TIMEOUT_MS = 60_000;

/** Resolution strategy outcome — one per attempted selector. */
type ResolvedVia = ReplaySelector['type'];

type MinimalPage = {
  evaluate: (fn: (...a: any[]) => unknown, ...args: unknown[]) => Promise<unknown>;
  goto?: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  keyboard?: { press: (key: string) => Promise<unknown> };
};

interface OcSkillReplayStepResult {
  index: number;
  resolved_via: ResolvedVia | null;
  selector_attempts: number;
  elapsed_ms: number;
  ok: boolean;
}

type FailureCode =
  | 'ARTIFACT_MISSING'
  | 'ARTIFACT_RESOLUTION_FAILED'
  | 'CONTRACT_FAILED'
  | 'STEP_TIMEOUT'
  | 'TARGET_NAVIGATED_AWAY'
  | 'DISABLED'
  | 'SKILL_NOT_FOUND'
  | 'INVALID_ARGS';

interface OcSkillReplayOutput {
  ok: boolean;
  steps_executed: number;
  steps_total: number;
  step_results: OcSkillReplayStepResult[];
  failure?: {
    code: FailureCode;
    step_index: number;
    detail: string;
    evidence_bundle_path?: string;
  };
}

const definition: MCPToolDefinition = {
  name: 'oc_skill_replay',
  description:
    'Deterministically replay a recorded skill by `skill_id`. Walks each step\'s ' +
    'replay_artifact and tries the persisted selectors in order — no LLM, no host ' +
    'round-trip per step. Returns `{ ok: true, ... }` on full success, or ' +
    '`{ ok: false, failure: { code, step_index, detail } }` on any failure. ' +
    'Core-tier; opt-out via OPENCHROME_SKILL_REPLAY=0.',
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: {
        type: 'string',
        description: 'REQUIRED skill_id returned by a prior oc_skill_record call.',
      },
      domain: {
        type: 'string',
        description:
          'REQUIRED Domain partition matching the domain used at record time.',
      },
      tabId: {
        type: 'string',
        description:
          'Optional tab id to drive. When omitted the active tab in the current session is used. ' +
          'When no live page is available, replay returns ARTIFACT_RESOLUTION_FAILED on the first step.',
      },
      step_range: {
        type: 'object',
        description: 'Optional half-open range { from, to }; defaults to the full step list.',
        properties: {
          from: { type: 'integer', minimum: 0 },
          to: { type: 'integer', minimum: 0 },
        },
      },
      stop_on_contract_failure: {
        type: 'boolean',
        description: 'When true (default), the first failed post_assert ends the replay.',
      },
      step_timeout_ms: {
        type: 'number',
        description:
          `Per-step resolution + dispatch budget. Default ${DEFAULT_STEP_TIMEOUT_MS}; ` +
          `clamped to [${MIN_STEP_TIMEOUT_MS}, ${MAX_STEP_TIMEOUT_MS}].`,
      },
    },
    required: ['skill_id', 'domain'],
  },
};

function clampStepTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_STEP_TIMEOUT_MS;
  return Math.max(MIN_STEP_TIMEOUT_MS, Math.min(MAX_STEP_TIMEOUT_MS, Math.floor(value)));
}

function failure(
  code: FailureCode,
  stepIndex: number,
  detail: string,
  totalSteps: number,
  stepResults: OcSkillReplayStepResult[],
  executed: number,
): OcSkillReplayOutput {
  return {
    ok: false,
    steps_executed: executed,
    steps_total: totalSteps,
    step_results: stepResults,
    failure: { code, step_index: stepIndex, detail },
  };
}

/**
 * Attempt to resolve a single selector against the live page.
 *
 * Returns the resolved `backendNodeId` when successful, or null otherwise.
 * This is intentionally minimal — the goal is to verify the selector matches
 * an element in the current DOM. Action dispatch is handled separately so
 * `oc_skill_replay` can stay deterministic even when puppeteer is absent.
 */
async function resolveSelector(
  selector: ReplaySelector,
  page: unknown,
): Promise<{ ok: true; backendNodeId: number } | { ok: false }> {
  if (!page) return { ok: false };
  const p = page as MinimalPage;
  try {
    const found = await p.evaluate((sel: ReplaySelector) => {
      const cssEscape = (value: string): string => {
        const esc = (globalThis as unknown as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
        if (esc) return esc(value);
        return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      };
      const textOf = (el: Element): string => (el.textContent || '').replace(/\s+/g, ' ').trim();
      const roleCandidates = (role: string): Element[] => {
        const native = role === 'button'
          ? ',button,input[type="button"],input[type="submit"],input[type="reset"]'
          : role === 'link'
            ? ',a[href]'
            : role === 'textbox'
              ? ',input:not([type]),input[type="text"],input[type="search"],input[type="email"],input[type="url"],textarea'
              : '';
        return Array.from(document.querySelectorAll(`[role="${cssEscape(role)}"]${native}`));
      };
      const matches = (el: Element): boolean => {
        if (sel.type === 'xpath') {
          const r = document.evaluate(sel.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          return r.singleNodeValue === el;
        }
        if (sel.type === 'css') return el.matches(sel.value);
        if (sel.type === 'text') return textOf(el).includes(sel.value);
        if (sel.type === 'accessible_name') {
          const name = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || '';
          return name === sel.value;
        }
        if (sel.type === 'role_name') {
          const role = el.getAttribute('role') || el.tagName.toLowerCase();
          if (role !== sel.role && !(sel.role === 'button' && ['button', 'input'].includes(el.tagName.toLowerCase())) && !(sel.role === 'link' && el.tagName.toLowerCase() === 'a')) return false;
          const name = el.getAttribute('aria-label') || textOf(el);
          return sel.name === '' || name === sel.name;
        }
        return false;
      };
      let el: Element | null = null;
      if (sel.type === 'xpath') {
        const r = document.evaluate(sel.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        el = r.singleNodeValue as Element | null;
      } else if (sel.type === 'css') {
        el = document.querySelector(sel.value);
      } else if (sel.type === 'text') {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = walker.nextNode())) {
          if (n.nodeValue && n.nodeValue.includes(sel.value)) {
            el = n.parentElement;
            break;
          }
        }
      } else if (sel.type === 'accessible_name') {
        const escaped = cssEscape(sel.value);
        el = document.querySelector(`[aria-label="${escaped}"],[alt="${escaped}"],[title="${escaped}"]`);
      } else if (sel.type === 'role_name') {
        el = roleCandidates(sel.role).find(matches) ?? null;
      }
      return el !== null;
    }, selector);
    return found ? { ok: true, backendNodeId: 0 } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function dispatchStep(step: ReplayArtifactStep, selector: ReplaySelector | null, page: unknown, timeoutMs: number): Promise<{ ok: true } | { ok: false; detail: string }> {
  const p = page as MinimalPage | null;
  try {
    if (step.kind === 'navigate') {
      const url = step.args?.url;
      if (typeof url !== 'string' || url.length === 0) return { ok: false, detail: 'navigate step requires args.url' };
      if (!p?.goto) return { ok: false, detail: 'navigate step requires a live page with goto support' };
      await withDeadline(Promise.resolve(p.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })), timeoutMs);
      return { ok: true };
    }
    if (!p || !selector) return { ok: false, detail: 'no live page or resolved selector available for action dispatch' };
    if (step.kind === 'press' && p.keyboard) {
      const key = step.args?.key;
      if (typeof key !== 'string' || key.length === 0) return { ok: false, detail: 'press step requires args.key' };
      const focused = await withDeadline(Promise.resolve(p.evaluate((sel: ReplaySelector) => {
        const cssEscape = (value: string): string => {
          const esc = (globalThis as unknown as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
          if (esc) return esc(value);
          return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        };
        let el: Element | null = null;
        if (sel.type === 'xpath') {
          const r = document.evaluate(sel.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          el = r.singleNodeValue as Element | null;
        } else if (sel.type === 'css') {
          el = document.querySelector(sel.value);
        } else if (sel.type === 'accessible_name') {
          const escaped = cssEscape(sel.value);
          el = document.querySelector(`[aria-label="${escaped}"],[alt="${escaped}"],[title="${escaped}"]`);
        } else if (sel.type === 'text') {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let n: Node | null;
          while ((n = walker.nextNode())) { if (n.nodeValue && n.nodeValue.includes(sel.value)) { el = n.parentElement; break; } }
        } else if (sel.type === 'role_name') {
          el = Array.from(document.querySelectorAll(`[role="${cssEscape(sel.role)}"],button,a[href],input,textarea`)).find((candidate) => {
            const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
            const name = candidate.getAttribute('aria-label') || text;
            return sel.name === '' || name === sel.name;
          }) ?? null;
        }
        if (!el) return false;
        (el as HTMLElement).focus();
        return document.activeElement === el;
      }, selector)), timeoutMs) as boolean;
      if (!focused) return { ok: false, detail: 'press target could not be focused' };
      await withDeadline(Promise.resolve(p.keyboard.press(key)), timeoutMs);
      return { ok: true };
    }
    const result = await withDeadline(Promise.resolve(p.evaluate((sel: ReplaySelector, kind: string, args: Record<string, unknown> | undefined) => {
      const cssEscape = (value: string): string => {
        const esc = (globalThis as unknown as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
        if (esc) return esc(value);
        return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      };
      const textOf = (el: Element): string => (el.textContent || '').replace(/\s+/g, ' ').trim();
      const roleCandidates = (role: string): Element[] => {
        const native = role === 'button'
          ? ',button,input[type="button"],input[type="submit"],input[type="reset"]'
          : role === 'link'
            ? ',a[href]'
            : role === 'textbox'
              ? ',input:not([type]),input[type="text"],input[type="search"],input[type="email"],input[type="url"],textarea'
              : '';
        return Array.from(document.querySelectorAll(`[role="${cssEscape(role)}"]${native}`));
      };
      const matches = (el: Element): boolean => {
        if (sel.type === 'css') return el.matches(sel.value);
        if (sel.type === 'text') return textOf(el).includes(sel.value);
        if (sel.type === 'accessible_name') return (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || '') === sel.value;
        if (sel.type === 'role_name') {
          const role = el.getAttribute('role') || el.tagName.toLowerCase();
          if (role !== sel.role && !(sel.role === 'button' && ['button', 'input'].includes(el.tagName.toLowerCase())) && !(sel.role === 'link' && el.tagName.toLowerCase() === 'a')) return false;
          const name = el.getAttribute('aria-label') || textOf(el);
          return sel.name === '' || name === sel.name;
        }
        return false;
      };
      let el: Element | null = null;
      if (sel.type === 'xpath') {
        const r = document.evaluate(sel.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        el = r.singleNodeValue as Element | null;
      } else if (sel.type === 'css') {
        el = document.querySelector(sel.value);
      } else if (sel.type === 'text') {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = walker.nextNode())) {
          if (n.nodeValue && n.nodeValue.includes(sel.value)) { el = n.parentElement; break; }
        }
      } else if (sel.type === 'accessible_name') {
        const escaped = cssEscape(sel.value);
        el = document.querySelector(`[aria-label="${escaped}"],[alt="${escaped}"],[title="${escaped}"]`);
      } else if (sel.type === 'role_name') {
        el = roleCandidates(sel.role).find(matches) ?? null;
      }
      if (!el) return { ok: false, detail: 'resolved selector no longer matches at dispatch time' };
      const htmlEl = el as HTMLElement;
      if (kind === 'click') {
        htmlEl.click();
        return { ok: true };
      }
      if (kind === 'fill') {
        const value = args?.value;
        if (typeof value !== 'string') return { ok: false, detail: 'fill step requires args.value' };
        if (!('value' in htmlEl)) return { ok: false, detail: 'target is not fillable' };
        htmlEl.focus();
        (htmlEl as HTMLInputElement | HTMLTextAreaElement).value = value;
        htmlEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        htmlEl.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }
      if (kind === 'select') {
        const value = args?.value;
        if (typeof value !== 'string') return { ok: false, detail: 'select step requires args.value' };
        if (!(htmlEl instanceof HTMLSelectElement)) return { ok: false, detail: 'target is not a select element' };
        htmlEl.value = value;
        htmlEl.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }
      if (kind === 'submit') {
        const form = htmlEl instanceof HTMLFormElement ? htmlEl : htmlEl.closest('form');
        if (form) {
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.submit();
          return { ok: true };
        }
        htmlEl.click();
        return { ok: true };
      }
      if (kind === 'scroll') {
        const x = typeof args?.x === 'number' ? args.x : 0;
        const y = typeof args?.y === 'number' ? args.y : 0;
        if (x !== 0 || y !== 0) window.scrollBy(x, y);
        else htmlEl.scrollIntoView({ block: 'center', inline: 'center' });
        return { ok: true };
      }
      if (kind === 'press') {
        htmlEl.focus();
        return { ok: true };
      }
      return { ok: false, detail: `unsupported step kind: ${kind}` };
    }, selector, step.kind, step.args)), timeoutMs) as { ok: boolean; detail?: string };
    return result.ok ? { ok: true } : { ok: false, detail: result.detail ?? 'action dispatch failed' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Walk one step's selector list. Returns the resolution outcome and which
 * strategy won. Pure: does not dispatch the action itself — `executeStep`
 * handles that on top of a successful resolution.
 */
async function resolveStep(
  step: ReplayArtifactStep,
  page: unknown,
): Promise<{
  resolvedVia: ResolvedVia | null;
  attempts: number;
  selector: ReplaySelector | null;
}> {
  // `navigate` is a no-resolve action — its target is `args.url`.
  if (step.kind === 'navigate') {
    return { resolvedVia: null, attempts: 0, selector: null };
  }
  let attempts = 0;
  for (const sel of step.selectors) {
    attempts++;
    const r = await resolveSelector(sel, page);
    if (r.ok) {
      return { resolvedVia: sel.type, attempts, selector: sel };
    }
  }
  return { resolvedVia: null, attempts, selector: null };
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const stepResults: OcSkillReplayStepResult[] = [];

  // Kill-switch: OPENCHROME_SKILL_REPLAY=0/false short-circuits before any
  // store read so a disabled deployment stays cheap.
  if (!isCoreFeatureEnabled('OPENCHROME_SKILL_REPLAY', true)) {
    const out: OcSkillReplayOutput = {
      ok: false,
      steps_executed: 0,
      steps_total: 0,
      step_results: [],
      failure: {
        code: 'DISABLED',
        step_index: -1,
        detail: 'oc_skill_replay disabled via OPENCHROME_SKILL_REPLAY env var',
      },
    };
    return jsonResult(out);
  }

  const skillId = args.skill_id;
  const domain = args.domain;
  const tabId = args.tabId as string | undefined;
  const stopOnContractFailure = args.stop_on_contract_failure !== false;
  const stepTimeoutMs = clampStepTimeout(args.step_timeout_ms);
  const stepRange = args.step_range as { from?: unknown; to?: unknown } | undefined;

  if (typeof skillId !== 'string' || skillId.length === 0) {
    return jsonResult(
      failure('INVALID_ARGS', -1, 'skill_id must be a non-empty string', 0, [], 0),
    );
  }
  if (typeof domain !== 'string' || domain.length === 0) {
    return jsonResult(
      failure('INVALID_ARGS', -1, 'domain must be a non-empty string', 0, [], 0),
    );
  }

  let store: SkillMemoryStore;
  try {
    store = new SkillMemoryStore({ domain });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult(
      failure('INVALID_ARGS', -1, `failed to open skill store: ${message}`, 0, [], 0),
    );
  }

  let record: SkillRecord | null;
  try {
    record = store.get(skillId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult(
      failure('SKILL_NOT_FOUND', -1, `store read failed: ${message}`, 0, [], 0),
    );
  }
  if (!record) {
    return jsonResult(
      failure('SKILL_NOT_FOUND', -1, `no skill recorded with id=${skillId}`, 0, [], 0),
    );
  }

  // Acceptance-criterion check: a v1 record (no replay artifacts) must surface
  // ARTIFACT_MISSING rather than synthesise one.
  const artifacts = record.replayArtifacts ?? [];
  const totalSteps = Array.isArray(record.steps) ? record.steps.length : 0;
  if (totalSteps === 0 || artifacts.length === 0 || artifacts.every((a) => a === null)) {
    return jsonResult(
      failure(
        'ARTIFACT_MISSING',
        0,
        'skill has no replay_artifact entries (v1 record or not captured)',
        totalSteps,
        [],
        0,
      ),
    );
  }

  // Step range clamping. `from` defaults to 0, `to` defaults to totalSteps.
  const fromRaw = stepRange && typeof stepRange.from === 'number' ? stepRange.from : 0;
  const toRaw = stepRange && typeof stepRange.to === 'number' ? stepRange.to : totalSteps;
  const from = Math.max(0, Math.min(totalSteps, Math.floor(fromRaw)));
  const to = Math.max(from, Math.min(totalSteps, Math.floor(toRaw)));

  // Acquire a page when possible. The replay tool is callable from contexts
  // that may not have a live page (tests, snapshot replays); in that case we
  // run resolution against `null` and surface ARTIFACT_RESOLUTION_FAILED on
  // the first action step that needs a DOM.
  let page: unknown = null;
  try {
    const sm = getSessionManager();
    if (sm && typeof sm.getPage === 'function') {
      let targetId = typeof tabId === 'string' && tabId.length > 0 ? tabId : undefined;
      if (!targetId && typeof (sm as { getSessionTargetIds?: (sid: string) => string[] }).getSessionTargetIds === 'function') {
        const ids = (sm as { getSessionTargetIds: (sid: string) => string[] }).getSessionTargetIds(sessionId);
        targetId = ids[ids.length - 1];
      }
      if (targetId) {
        page = await sm.getPage(sessionId, targetId, undefined, 'oc_skill_replay');
      }
    }
  } catch {
    page = null;
  }

  let executed = 0;
  for (let i = from; i < to; i++) {
    const artifact = artifacts[i];
    if (!artifact) {
      return jsonResult(
        failure(
          'ARTIFACT_MISSING',
          i,
          `step ${i} has no replay_artifact (heterogeneous v1/v2 record)`,
          totalSteps,
          stepResults,
          executed,
        ),
      );
    }
    const v = validateReplayArtifact(artifact);
    if (!v.ok) {
      return jsonResult(
        failure(
          'ARTIFACT_MISSING',
          i,
          `step ${i} artifact failed validation: ${v.error ?? 'unknown'}`,
          totalSteps,
          stepResults,
          executed,
        ),
      );
    }
    if (artifact.steps.length !== 1) {
      return jsonResult(
        failure(
          'ARTIFACT_MISSING',
          i,
          `step ${i} artifact must contain exactly one embedded step (got ${artifact.steps.length})`,
          totalSteps,
          stepResults,
          executed,
        ),
      );
    }
    const step = artifact.steps[0]; // each per-step artifact carries one step
    if (!step) {
      return jsonResult(
        failure(
          'ARTIFACT_MISSING',
          i,
          `step ${i} artifact has no embedded step entry`,
          totalSteps,
          stepResults,
          executed,
        ),
      );
    }

    const started = Date.now();
    let resolution: { resolvedVia: ResolvedVia | null; attempts: number; selector: ReplaySelector | null };
    try {
      resolution = await withDeadline(resolveStep(step, page), stepTimeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stepResults.push({
        index: i,
        resolved_via: null,
        selector_attempts: step.selectors.length,
        elapsed_ms: Date.now() - started,
        ok: false,
      });
      return jsonResult(
        failure('STEP_TIMEOUT', i, message, totalSteps, stepResults, executed),
      );
    }

    if (step.kind !== 'navigate' && resolution.resolvedVia === null) {
      stepResults.push({
        index: i,
        resolved_via: null,
        selector_attempts: resolution.attempts,
        elapsed_ms: Date.now() - started,
        ok: false,
      });
      return jsonResult(
        failure(
          'ARTIFACT_RESOLUTION_FAILED',
          i,
          `no selector strategy resolved (tried ${resolution.attempts}/${step.selectors.length})`,
          totalSteps,
          stepResults,
          executed,
        ),
      );
    }

    const action = await dispatchStep(step, resolution.selector, page, stepTimeoutMs);
    if (!action.ok) {
      stepResults.push({
        index: i,
        resolved_via: resolution.resolvedVia,
        selector_attempts: resolution.attempts,
        elapsed_ms: Date.now() - started,
        ok: false,
      });
      return jsonResult(
        failure(
          step.kind === 'navigate' ? 'TARGET_NAVIGATED_AWAY' : 'ARTIFACT_RESOLUTION_FAILED',
          i,
          action.detail,
          totalSteps,
          stepResults,
          executed,
        ),
      );
    }

    stepResults.push({
      index: i,
      resolved_via: resolution.resolvedVia,
      selector_attempts: resolution.attempts,
      elapsed_ms: Date.now() - started,
      ok: true,
    });
    executed++;

    // post_assert hook — for v1.11 we surface the contract id in the failure
    // detail but defer evaluation to the host (oc_assert is snapshot-driven
    // and needs caller-supplied evidence). When the host wants enforcement
    // it can chain oc_skill_replay → oc_assert deterministically.
    if (step.post_assert && stopOnContractFailure) {
      return jsonResult(
        failure(
          'CONTRACT_FAILED',
          i,
          `post_assert ${step.post_assert.contract_id} requires an assertion evaluator before replay can report success`,
          totalSteps,
          stepResults,
          executed,
        ),
      );
    }
  }

  // Mark the skill used so the recall layer reflects the replay activity.
  try {
    await store.markUsed(skillId, Date.now(), true);
  } catch {
    // markUsed is best-effort; replay success is independent of accounting.
  }

  const out: OcSkillReplayOutput = {
    ok: true,
    steps_executed: executed,
    steps_total: totalSteps,
    step_results: stepResults,
  };
  return jsonResult(out);
};

/**
 * Run `p` but reject with a STEP_TIMEOUT error after `ms` ms. We use a manual
 * timer so a misbehaving selector cannot wedge the replay loop.
 */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`step exceeded ${ms}ms budget`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function jsonResult(payload: OcSkillReplayOutput): MCPResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
    ...payload,
  };
}

export function registerOcSkillReplayTool(server: MCPServer): void {
  server.registerTool('oc_skill_replay', handler, definition);
}

/** Exposed for unit testing. */
export const __test = {
  resolveStep,
  resolveSelector,
  dispatchStep,
  clampStepTimeout,
};
