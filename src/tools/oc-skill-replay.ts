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
import { SkillMemoryStore, type SkillRecord } from '../core/skill-memory';
import { getSessionManager } from '../session-manager';
import {
  runReplay,
  DEFAULT_STEP_TIMEOUT_MS,
  MAX_STEP_TIMEOUT_MS,
  type ContractEvaluator,
  type FrozenSnapshotReader,
  type ReplayCdpClient,
  type ReplayTraceEmitter,
  type SkillReplayResult,
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

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const input = args as unknown as OcSkillReplayInput;

  if (typeof input.skill_id !== 'string' || input.skill_id.length === 0) {
    return errorResult('missing required field: skill_id');
  }
  if (typeof input.domain !== 'string' || input.domain.length === 0) {
    return errorResult('missing required field: domain');
  }
  if (typeof input.tabId !== 'string' || input.tabId.length === 0) {
    return errorResult('missing required field: tabId');
  }

  const sessionManager = getSessionManager();
  const page = await sessionManager.getPage(sessionId, input.tabId, undefined, 'oc_skill_replay');
  if (!page) {
    return errorResult(`tab not found: ${input.tabId}`);
  }
  const cdpClient = sessionManager.getCDPClient();

  let store: SkillMemoryStore;
  try {
    store = new SkillMemoryStore({ domain: input.domain });
  } catch (err) {
    return errorResult(`failed to initialise skill memory store: ${stringify(err)}`);
  }

  const cdp: ReplayCdpClient = {
    async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
      return cdpClient.send(page, method, params);
    },
    async getActiveUrl(): Promise<string | null> {
      // Surface errors to the replay engine; the engine's origin gate now
      // fails closed when the active URL cannot be retrieved (Gemini review
      // on #928).
      return page.url();
    },
    async awaitFrameNavigated(timeoutMs: number): Promise<void> {
      // Propagate timeouts/errors as rejections so the replay engine can
      // mark the step as STEP_FAIL. Previously this swallowed all failures
      // via `.catch(() => {})`, which let a missing navigation be treated
      // as a success and broke the deterministic step contract (Codex
      // review on #928).
      await page.waitForNavigation({ timeout: timeoutMs });
    },
  };

  const snapshotReader: FrozenSnapshotReader = {
    async readUrlOrigin(skill: SkillRecord): Promise<string | null> {
      // The frozen snapshot is an opaque JSON blob written by oc_skill_record
      // (see src/tools/oc-skill-record.ts). When that blob includes a
      // `url_origin` field, the precondition gate uses it to refuse
      // cross-origin replay (Codex review on #928 P1: returning null
      // unconditionally disables the gate and lets a skill recorded on one
      // site execute its CDP steps on another).
      if (!skill.frozenSnapshotPath) return null;
      try {
        const snapshot = store.readFrozenSnapshot(skill.frozenSnapshotPath);
        const origin = snapshot?.url_origin;
        return typeof origin === 'string' && origin.length > 0 ? origin : null;
      } catch {
        // Fail closed: if we can't read the snapshot but a path was promised,
        // the gate at runReplay()'s origin-check stage will surface
        // origin_check_failed via its own fail-closed branch.
        return null;
      }
    },
  };

  const evaluator: ContractEvaluator = {
    async evaluate({ skill, contractId }) {
      // Interpret contractId as a JS expression. Empty / unknown returns
      // not-evaluated which the engine surfaces as CONTRACT_FAIL.
      const expr = contractId;
      if (!expr || expr.length === 0) {
        return { evaluated: false, passed: false };
      }
      try {
        // Use CDP Runtime.evaluate so we can take an arbitrary JS expression
        // (page.evaluate() requires a function literal at the type level).
        const evalResult = (await cdpClient.send(page, 'Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
          awaitPromise: true,
        })) as { result?: { value?: unknown } };
        const value = evalResult?.result?.value;
        const passed = value === true;
        return {
          evaluated: true,
          passed,
          detail: { value, expression_length: expr.length, skill_id: skill.skillId },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { evaluated: false, passed: false, detail: { error: msg } };
      }
    },
  };

  const trace: ReplayTraceEmitter = {
    emit() {
      // Trace JSONL emission is left to the active TraceRecorder. The
      // engine writes recordReplayResult unconditionally; the dedicated
      // skill_replay event hook ties into the trace recorder in a
      // follow-up. Keeping this stub keeps the engine's invariant #6
      // satisfied at the type level.
    },
  };

  const result: SkillReplayResult = await runReplay({
    skillId: input.skill_id,
    contractId: input.contract_id,
    stepTimeoutMs: input.step_timeout_ms,
    store,
    cdp,
    snapshotReader,
    evaluator,
    trace,
  });

  return jsonResult(result);
};

function stringify(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorResult(message: string): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function jsonResult(payload: SkillReplayResult): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(payload as unknown as Record<string, unknown>),
  };
}

export function registerOcSkillReplayTool(server: MCPServer): void {
  if (!isSkillReplayEnabled()) return;
  server.registerTool('oc_skill_replay', handler, definition);
}
