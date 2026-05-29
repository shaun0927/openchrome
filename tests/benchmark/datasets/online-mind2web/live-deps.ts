/**
 * Online-Mind2Web live-run production dependencies (#1427 Part 2 + #1428 wiring).
 *
 * Builds a production `RunnerDeps` (see ./runner) that:
 *   1. step()      — drives ONE OM2W step by running the Anthropic tool-use
 *                    loop (`runAnthropicToolUseLoop`) against an injected
 *                    `MCPAdapter`, using an OM2W tool set modelled on the
 *                    WebVoyager tool definitions. Evidence is captured through
 *                    a `CapturingOM2WAdapter` wrapper.
 *   2. judge()     — a REAL Claude LLM-as-Judge: sends task_description +
 *                    accumulated evidence to the injected `AnthropicMessagesClient`
 *                    and parses a strict JSON `{passed, reason}` verdict,
 *                    falling back to `{passed:false}` on any parse failure.
 *   3. shouldStop() — feeds the step history into the marginal-utility tracker
 *                    and asks `recommendEarlyStop(...)` (#1428).
 *
 * Everything that touches the network or a browser is dependency-injected
 * (`client`, `model`, `adapter`), so this module is fully unit-testable with
 * fakes and runs in CI without an API key or a browser.
 */

import type { MCPAdapter, MCPToolResult } from '../../benchmark-runner';
import { runAnthropicToolUseLoop, type AnthropicMessagesClient } from '../../llm-provider/anthropic-loop';
import {
  initialMarginalUtilityState,
  recordStep,
  summary as marginalUtilitySummary,
  type MarginalUtilityState,
} from '../../../../src/core/task-ledger/marginal-utility';
import {
  recommendEarlyStop,
  type EarlyStopPolicy,
} from '../../../../src/core/task-ledger/early-stop';
import type { OnlineMind2WebTask } from './loader';
import type { JudgeVerdict, RunnerDeps, RunnerStep } from './runner';

/**
 * OM2W browser tool set. Modelled on WEBVOYAGER_TOOLS' definition style — a
 * flat list of MCP tools the model may call to drive a single step. The
 * adapter is responsible for actually executing these against the live
 * browser; here we only describe their shape for the model.
 */
export const OM2W_TOOLS = [
  {
    name: 'navigate',
    description: 'Navigate the active browser tab to the requested URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'tabs_create',
    description: 'Open a new browser tab at the requested URL and return a tabId.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_page',
    description: 'Read the current browser page payload (text + interactive elements).',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'act',
    description: 'Perform a high-level natural-language action on the page (e.g. "click the search button").',
    inputSchema: {
      type: 'object',
      properties: { instruction: { type: 'string' } },
      required: ['instruction'],
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description: 'Click an element identified by a selector or accessible label.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'type',
    description: 'Type text into an input element identified by a selector or accessible label.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' }, text: { type: 'string' } },
      required: ['target', 'text'],
      additionalProperties: false,
    },
  },
] as const;

/** Default model used when none is injected. */
export const DEFAULT_OM2W_MODEL = 'claude-3-5-sonnet-latest';

/**
 * Default model<->tool turns allowed per single OM2W step. A step is meant to
 * be ONE concrete action (optionally read the page, then act), so this is kept
 * small on purpose. Without it the inner tool-use loop would fall back to
 * WEBVOYAGER_BUDGET.max_tool_iterations (50) — a whole-task budget that, on
 * OM2W's per-step runner (up to step_budget=100 steps), would permit ~100x50
 * model turns per task. Callers may override via CreateLiveDepsOptions.
 */
export const DEFAULT_OM2W_MAX_TURNS_PER_STEP = 8;

/** Default judge id surfaced on live verdicts. */
const LIVE_JUDGE_ID = 'claude-llm-judge';

function textFromResult(result: MCPToolResult): string {
  return (result.content || [])
    .map((part) => part.text ?? part.data ?? '')
    .filter(Boolean)
    .join('\n');
}

/**
 * Wraps an inner `MCPAdapter`, recording the most recent tool calls so a
 * single OM2W step can be summarised into a `RunnerStep`. Mirrors the
 * WebVoyager `CapturingBenchmarkAdapter` capture pattern.
 */
export class CapturingOM2WAdapter implements MCPAdapter {
  readonly name: string;
  readonly mode: string;
  readonly kind?: MCPAdapter['kind'];
  readonly version?: string;

  /** The tool calls made during the most recent step() invocation. */
  private calls: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; text: string }> = [];

  constructor(private readonly inner: MCPAdapter) {
    this.name = inner.name;
    this.mode = inner.mode;
    this.kind = inner.kind;
    this.version = inner.version;
  }

  async setup(): Promise<void> {
    await this.inner.setup?.();
  }

  async teardown(): Promise<void> {
    await this.inner.teardown?.();
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const result = await this.inner.callTool(toolName, args);
    this.calls.push({
      tool: toolName,
      args,
      ok: !result.isError,
      text: textFromResult(result),
    });
    return result;
  }

  /** Reset the per-step capture buffer. Call before each step. */
  resetStepCapture(): void {
    this.calls = [];
  }

  /** Snapshot of the tool calls captured since the last reset. */
  capturedCalls(): ReadonlyArray<{ tool: string; args: Record<string, unknown>; ok: boolean; text: string }> {
    return this.calls;
  }
}

export interface CreateLiveDepsOptions {
  /** Injectable Anthropic client (real SDK in prod, fake in tests). */
  client: AnthropicMessagesClient;
  /** Injectable MCP adapter (OpenChromeRealAdapter in prod, fake in tests). */
  adapter: MCPAdapter;
  /** Model id; defaults to {@link DEFAULT_OM2W_MODEL}. */
  model?: string;
  /** Max model<->tool iterations per single OM2W step. */
  maxTurnsPerStep?: number;
  /** Early-stop policy overrides forwarded to recommendEarlyStop. */
  earlyStopPolicy?: EarlyStopPolicy;
  /** Clock injection for deterministic marginal-utility timestamps. */
  now?: () => number;
}

const STEP_SYSTEM_PROMPT = [
  'You are an autonomous web agent running the Online-Mind2Web benchmark.',
  'Use only the provided browser tools to make progress on the task.',
  'On each turn take the single next concrete action that advances the task,',
  'then stop and report what you did. Do not invent browser state.',
].join('\n');

function stepUserPrompt(task: OnlineMind2WebTask, stepIndex: number, history: RunnerStep[]): string {
  const historyLines = history.length
    ? history.map((h) => `  step ${h.step}: ${h.tool} -> ${h.ok ? 'ok' : 'error'} (${h.summary})`).join('\n')
    : '  (none yet)';
  return [
    `Task: ${task.task_description}`,
    `Target website: ${task.website}`,
    `This is step ${stepIndex}. Prior steps:`,
    historyLines,
    'Take the next action now using a browser tool.',
  ].join('\n');
}

/**
 * Summarise the captured tool calls of one step into a single RunnerStep.
 * If the model emitted no tool call this step is recorded as a no-op.
 */
function summariseStep(
  stepIndex: number,
  calls: ReadonlyArray<{ tool: string; args: Record<string, unknown>; ok: boolean; text: string }>,
  finalText: string,
): RunnerStep {
  if (calls.length === 0) {
    // A no-op turn (the model talked but called no tool) is recorded as ok:true
    // by design: it is a benign "nothing happened this step", not a hard failure
    // — the model often emits a terminal "done"/completion sentence here, and the
    // judge rules on the accumulated evidence. It is NOT a runaway risk: the
    // marginal-utility tracker feeds shouldStop(), which plateaus and stops the
    // runner well before the step budget is exhausted on a stuck model.
    return {
      step: stepIndex,
      tool: 'none',
      args: {},
      ok: true,
      summary: finalText.trim() || 'model produced no tool call',
    };
  }
  // The last tool call drives the step's headline outcome.
  const last = calls[calls.length - 1];
  const summaryParts = [finalText.trim(), last.text.trim()].filter(Boolean);
  return {
    step: stepIndex,
    tool: last.tool,
    args: last.args,
    ok: calls.every((c) => c.ok),
    summary: summaryParts.join(' | ') || `${last.tool} executed`,
  };
}

/**
 * Parse the judge's reply into a JudgeVerdict. Accepts a bare JSON object or
 * a JSON object embedded in surrounding prose / code fences. Any failure to
 * extract a well-formed `{passed, reason}` falls back to passed:false.
 */
export function parseJudgeReply(text: string): JudgeVerdict {
  const fallback = (reason: string): JudgeVerdict => ({
    passed: false,
    reason,
    judge_id: LIVE_JUDGE_ID,
  });

  if (!text || text.trim() === '') {
    return fallback('judge returned empty response');
  }

  // Scan for balanced JSON object substrings (string-aware, so a brace inside
  // a string or surrounding prose does not corrupt the slice). The first
  // candidate that decodes to an object carrying a boolean `passed` wins; this
  // tolerates code-fenced or prose-embedded verdicts without a greedy
  // first-`{`..last-`}` slice that breaks on stray braces in the prose.
  const candidates = extractJsonObjectCandidates(text);
  if (candidates.length === 0) {
    return fallback(`judge response is not JSON: ${text.slice(0, 200)}`);
  }

  let lastObject: Record<string, unknown> | null = null;
  let lastParseError: string | null = null;
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      lastParseError = (err as Error).message;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.passed === 'boolean') {
      const reason = typeof obj.reason === 'string' && obj.reason.trim() !== ''
        ? obj.reason
        : 'no reason provided';
      return { passed: obj.passed, reason, judge_id: LIVE_JUDGE_ID };
    }
    if (lastObject === null) {
      lastObject = obj;
    }
  }

  if (lastObject !== null) {
    return fallback(`judge response missing boolean "passed": ${JSON.stringify(lastObject).slice(0, 200)}`);
  }
  if (lastParseError !== null) {
    return fallback(`judge response JSON parse failed: ${lastParseError}`);
  }
  return fallback('judge response did not decode to an object');
}

/**
 * Extract every balanced `{...}` substring from `text`, in start-index order,
 * ignoring braces that appear inside JSON string literals. Used to locate a
 * judge verdict object that may be wrapped in prose or code fences.
 */
function extractJsonObjectCandidates(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          break;
        }
      }
    }
  }
  return out;
}

const JUDGE_SYSTEM_PROMPT = [
  'You are a strict evaluator for the Online-Mind2Web web-agent benchmark.',
  "Given a task and the agent's step-by-step evidence, decide whether the task was completed.",
  'Be conservative: only mark passed=true when the evidence clearly demonstrates success.',
  'Respond with a single JSON object and nothing else: {"passed": boolean, "reason": string}.',
].join('\n');

function judgeUserPrompt(task: OnlineMind2WebTask, evidence: RunnerStep[]): string {
  const evidenceLines = evidence.length
    ? evidence
        .map((e) => `  step ${e.step}: ${e.tool}(${JSON.stringify(e.args)}) -> ${e.ok ? 'ok' : 'error'}: ${e.summary}`)
        .join('\n')
    : '  (no steps recorded)';
  return [
    `Task: ${task.task_description}`,
    `Target website: ${task.website}`,
    'Agent evidence:',
    evidenceLines,
    'Did the agent complete the task? Reply with the JSON object only.',
  ].join('\n');
}

/** Extract the assistant text from a raw Anthropic Messages response. */
function textFromAnthropicRaw(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') return '';
  const content = (raw as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
}

/**
 * Build a production `RunnerDeps` from injected primitives. The returned deps
 * are stateful only through the wrapped capturing adapter and a
 * marginal-utility tracker rebuilt from history on each shouldStop() call.
 */
export function createLiveOnlineMind2WebDeps(options: CreateLiveDepsOptions): RunnerDeps {
  const model = options.model ?? DEFAULT_OM2W_MODEL;
  const now = options.now ?? Date.now;
  const maxTurnsPerStep = options.maxTurnsPerStep ?? DEFAULT_OM2W_MAX_TURNS_PER_STEP;
  const adapter = new CapturingOM2WAdapter(options.adapter);
  const tools = OM2W_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }));

  // The marginal-utility tracker is rebuilt from history on each shouldStop()
  // call so the deps object stays free of cross-task leakage.
  const rebuildTracker = (history: RunnerStep[]): MarginalUtilityState => {
    let state = initialMarginalUtilityState();
    let ts = now();
    for (const s of history) {
      ts += 1;
      state = recordStep(state, {
        ts,
        toolOk: s.ok,
        assertPasses: 0,
        assertFails: 0,
        assertInconclusives: 0,
        checkpointAdvanced: false,
      });
    }
    return state;
  };

  const step: RunnerDeps['step'] = async (task, stepIndex, history) => {
    adapter.resetStepCapture();
    const loop = await runAnthropicToolUseLoop({
      client: options.client,
      adapter,
      model,
      system: STEP_SYSTEM_PROMPT,
      user: stepUserPrompt(task, stepIndex, history),
      tools,
      maxTurns: maxTurnsPerStep,
    });
    const result = summariseStep(stepIndex, adapter.capturedCalls(), loop.finalText);
    // A budget/iteration abort means the agent ran out of turns or token/USD
    // budget before completing this step. Surface it as a failed step (mirrors
    // the WebVoyager live runner, which records run.aborted) so the runner
    // stops and the abort reason reaches the judge's evidence — otherwise a
    // truncated step would be scored as a clean success and silently skew the
    // benchmark pass-rate.
    if (loop.aborted) {
      return {
        ...result,
        ok: false,
        summary: `${result.summary} | step aborted: ${loop.aborted}`,
      };
    }
    return result;
  };

  const judge: RunnerDeps['judge'] = async (task, evidence) => {
    let raw: unknown;
    try {
      raw = await options.client.create({
        model,
        system: JUDGE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: judgeUserPrompt(task, evidence) }],
      });
    } catch (err) {
      return {
        passed: false,
        reason: `judge invocation failed: ${(err as Error).message}`,
        judge_id: LIVE_JUDGE_ID,
      };
    }
    return parseJudgeReply(textFromAnthropicRaw(raw));
  };

  const shouldStop: NonNullable<RunnerDeps['shouldStop']> = (history) => {
    if (history.length === 0) return false;
    const state = rebuildTracker(history);
    const rec = recommendEarlyStop(marginalUtilitySummary(state), options.earlyStopPolicy);
    return rec.should_stop;
  };

  return { step, judge, shouldStop };
}
