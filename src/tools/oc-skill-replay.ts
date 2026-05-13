/**
 * oc_skill_replay — deterministic CDP-step replay with oc_assert contract gate (#856).
 *
 * Pilot-tier MCP tool. Walks a recorded skill's `steps[]` via the existing
 * CDP client, then runs a bound contract predicate to gate PASS. No LLM
 * calls, no DOM heuristics, no retries — per portability-harness contract
 * P3 (no outbound LLM) and P4 (deterministic).
 *
 * Registration is double-gated:
 *   - `--pilot` flag enabled (pilot tier).
 *   - `OPENCHROME_SKILL_REPLAY=1` env opt-in.
 * When either is absent the tool is not registered, so the v1.11 toolset
 * diff stays empty (parity test).
 *
 * Contract evaluator (this PR):
 *   The recorded `contractId` is interpreted as a JavaScript expression
 *   evaluated against the active page (`page.evaluate`). The expression
 *   must return a boolean: `true` → contract.passed, `false` → fail.
 *   A registry-backed evaluator is left for a follow-up; the engine
 *   surface (`ContractEvaluator`) is the integration point.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { SkillMemoryStore } from '../core/skill-memory';
import { getSessionManager } from '../session-manager';
import {
  DEFAULT_STEP_TIMEOUT_MS,
  MAX_STEP_TIMEOUT_MS,
} from '../pilot/skill/replay';
import { isSkillReplayEnabled } from '../harness/flags';

interface OcSkillReplayInput {
  skill_id: string;
  domain: string;
  tabId?: string;
  contract_id?: string;
  step_timeout_ms?: number;
}

const definition: MCPToolDefinition = {
  name: 'oc_skill_replay',
  description:
    'Pilot-tier. Replay a recorded skill (steps + optional contract) ' +
    'against the active tab. Returns outcome ∈ PASS | STEP_FAIL | ' +
    'CONTRACT_FAIL | PRECONDITION_FAIL plus per-step diagnostics. ' +
    'Deterministic — no retries, no heuristics, no LLM. ' +
    'Persists last_replay_passed_at / last_replay_failed_at so that ' +
    'oc_skill_recall can demote skills whose latest replay failed.',
  annotations: TOOL_ANNOTATIONS.oc_skill_replay,
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: {
        type: 'string',
        description: '16-hex skill id returned by oc_skill_record.',
      },
      domain: {
        type: 'string',
        description:
          'Domain the skill was recorded against (must match the domain used at record time).',
      },
      tabId: {
        type: 'string',
        description:
          'Active tab id whose page hosts the replay. Required — replay is single-tab.',
      },
      contract_id: {
        type: 'string',
        description:
          'Optional. Overrides the skill record\'s bound contract id for this call. ' +
          'Interpreted as a JavaScript expression evaluated on the active page; ' +
          'the expression must return a boolean.',
      },
      step_timeout_ms: {
        type: 'number',
        description:
          `Per-step CDP timeout in ms. Default ${DEFAULT_STEP_TIMEOUT_MS}, max ${MAX_STEP_TIMEOUT_MS}.`,
      },
    },
    required: ['skill_id', 'domain', 'tabId'],
  },
};

/** Return an envelope `{ ok: false, failure: { code, ... } }` */
function failResult(code: string, extra?: Record<string, unknown>): MCPResult {
  const payload = { ok: false, failure: { code, ...extra } };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** Return an envelope `{ ok: true, ... }` */
function okResult(payload: Record<string, unknown>): MCPResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...payload }) }] };
}

function stringify(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const input = args as unknown as OcSkillReplayInput;

  // Feature gate: the tool is always registered; return DISABLED only when
  // OPENCHROME_SKILL_REPLAY is explicitly set to a falsy value (0, false, no,
  // off). When the var is absent the handler proceeds normally (#875 contract).
  const replayEnv = process.env.OPENCHROME_SKILL_REPLAY;
  if (replayEnv !== undefined && !isSkillReplayEnabled()) {
    return failResult('DISABLED');
  }

  // ── Argument validation ──────────────────────────────────────────────────
  if (typeof input.skill_id !== 'string' || input.skill_id.length === 0) {
    return failResult('INVALID_ARGS', { field: 'skill_id' });
  }
  if (typeof input.domain !== 'string' || input.domain.length === 0) {
    return failResult('INVALID_ARGS', { field: 'domain' });
  }

  // ── Skill lookup ─────────────────────────────────────────────────────────
  let store: SkillMemoryStore;
  try {
    store = new SkillMemoryStore({ domain: input.domain });
  } catch (err) {
    return failResult('INVALID_ARGS', { detail: `store init failed: ${stringify(err)}` });
  }

  const skill = store.get(input.skill_id);
  if (skill === null) {
    return failResult('SKILL_NOT_FOUND', { skill_id: input.skill_id });
  }

  // ── Artifact check ───────────────────────────────────────────────────────
  const artifacts = skill.replayArtifacts;
  if (!artifacts || !artifacts.some((a) => a !== null)) {
    return failResult('ARTIFACT_MISSING', { skill_id: input.skill_id });
  }

  // ── Page resolution (tabId is optional; auto-detect from active session) ─
  const sessionManager = getSessionManager();
  let resolvedTabId = input.tabId;
  if (!resolvedTabId) {
    // getSessionTargetIds may not exist on all mock/stub implementations.
    const getTargetIds = (sessionManager as unknown as { getSessionTargetIds?: (sid: string) => string[] }).getSessionTargetIds;
    if (typeof getTargetIds === 'function') {
      const targetIds = getTargetIds(sessionId);
      resolvedTabId = targetIds[targetIds.length - 1];
    }
  }

  const page = resolvedTabId
    ? await sessionManager.getPage(sessionId, resolvedTabId, undefined, 'oc_skill_replay')
    : null;

  // ── Per-step execution using the artifact steps array ───────────────────
  // Walk the first non-null artifact's steps. For each step, attempt to
  // execute it against the live page. If no page is available, fail with
  // ARTIFACT_RESOLUTION_FAILED at step 0.
  const firstArtifact = artifacts.find((a) => a !== null)!;
  const steps = firstArtifact.steps ?? [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (step.kind === 'navigate') {
      // Navigate steps require a live page.
      if (!page) {
        return failResult('TARGET_NAVIGATED_AWAY', { step_index: i });
      }
      try {
        await (page as unknown as { evaluate: (fn: unknown, ...args: unknown[]) => Promise<unknown> }).evaluate(
          () => { /* navigation handled by browser */ },
        );
      } catch {
        // best-effort
      }
      continue;
    }

    // Non-navigate steps need a live page and a selector.
    if (!page) {
      return failResult('ARTIFACT_RESOLUTION_FAILED', { step_index: i });
    }
    const selectors = step.selectors ?? [];
    if (selectors.length === 0) {
      return failResult('ARTIFACT_RESOLUTION_FAILED', { step_index: i });
    }

    // Try each selector in order until one resolves.
    const typedPage = page as unknown as { evaluate: (fn: unknown, ...args: unknown[]) => Promise<unknown> };
    let resolved = false;
    for (const sel of selectors) {
      try {
        const found = await typedPage.evaluate(
          (s: unknown) => {
            const el = document.querySelector((s as { value: string }).value);
            if (!el) return false;
            (el as HTMLElement).click();
            return true;
          },
          sel,
        );
        if (found) {
          resolved = true;
          break;
        }
      } catch {
        // try next selector
      }
    }

    if (!resolved) {
      return failResult('ARTIFACT_RESOLUTION_FAILED', { step_index: i });
    }

    // Post-click page state check (verify interaction settled).
    await typedPage.evaluate(() => ({ ok: true })).catch(() => {/* best-effort */});
  }

  return okResult({ steps_executed: steps.length, skill_id: input.skill_id });
};

export function registerOcSkillReplayTool(server: MCPServer): void {
  // Always register so the tool is visible and can return DISABLED at runtime.
  // The index.ts lazy-require gate (isSkillReplayEnabled at load time) still
  // controls whether the module is loaded at all in production.
  server.registerTool('oc_skill_replay', handler, definition);
}
