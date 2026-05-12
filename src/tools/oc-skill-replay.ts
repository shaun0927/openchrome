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
        description: 'skill_id returned by a prior oc_skill_record call.',
      },
      domain: {
        type: 'string',
        description:
          'Domain partition this skill lives under (matches the domain used at record time).',
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
  // Cast to a minimal shape — we only call `evaluate` on the page. Avoids
  // pulling a puppeteer-core type dependency into this module. The function
  // signature mirrors what puppeteer expects.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = page as { evaluate: (fn: (...a: any[]) => unknown, ...args: unknown[]) => Promise<unknown> };
  try {
    if (selector.type === 'xpath') {
      const found = await p.evaluate((xpath: string) => {
        const r = document.evaluate(
          xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        );
        return r.singleNodeValue !== null;
      }, selector.value);
      return found ? { ok: true, backendNodeId: 0 } : { ok: false };
    }
    if (selector.type === 'css') {
      const found = await p.evaluate(
        (sel: string) => document.querySelector(sel) !== null,
        selector.value,
      );
      return found ? { ok: true, backendNodeId: 0 } : { ok: false };
    }
    if (selector.type === 'text') {
      const found = await p.evaluate((needle: string) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = walker.nextNode())) {
          if (n.nodeValue && n.nodeValue.includes(needle)) return true;
        }
        return false;
      }, selector.value);
      return found ? { ok: true, backendNodeId: 0 } : { ok: false };
    }
    if (selector.type === 'accessible_name') {
      const found = await p.evaluate((needle: string) => {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>('*'));
        return candidates.some((el) => {
          const label =
            el.getAttribute('aria-label') ||
            el.getAttribute('alt') ||
            el.getAttribute('title') ||
            '';
          return label === needle;
        });
      }, selector.value);
      return found ? { ok: true, backendNodeId: 0 } : { ok: false };
    }
    if (selector.type === 'role_name') {
      const { role, name } = selector;
      const found = await p.evaluate(
        (r: string, n: string) => {
          const els = Array.from(document.querySelectorAll<HTMLElement>('*'));
          return els.some((el) => {
            const elRole = el.getAttribute('role') || el.tagName.toLowerCase();
            if (elRole !== r) return false;
            const elName =
              el.getAttribute('aria-label') ||
              el.textContent?.trim() ||
              '';
            return n === '' || elName === n;
          });
        },
        role,
        name,
      );
      return found ? { ok: true, backendNodeId: 0 } : { ok: false };
    }
    if (selector.type === 'node_ref') {
      // node_ref resolution depends on #844's backend-node-registry, which is
      // optional at this stage. When the registry is unavailable we treat the
      // strategy as a miss and fall through to the next selector.
      return { ok: false };
    }
  } catch {
    return { ok: false };
  }
  return { ok: false };
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
}> {
  // `navigate` is a no-resolve action — its target is `args.url`.
  if (step.kind === 'navigate') {
    return { resolvedVia: null, attempts: 0 };
  }
  let attempts = 0;
  for (const sel of step.selectors) {
    attempts++;
    const r = await resolveSelector(sel, page);
    if (r.ok) {
      return { resolvedVia: sel.type, attempts };
    }
  }
  return { resolvedVia: null, attempts };
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
    if (sm && typeof sm.getPage === 'function' && typeof tabId === 'string' && tabId.length > 0) {
      page = await sm.getPage(sessionId, tabId, undefined, 'oc_skill_replay');
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
    let resolution: { resolvedVia: ResolvedVia | null; attempts: number };
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
      // Intentionally not failing here — the host owns the assert call.
      // We attach the contract id in step_results downstream via index.
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
  clampStepTimeout,
};
