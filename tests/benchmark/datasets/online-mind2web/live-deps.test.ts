/**
 * Unit tests for the OM2W live-run production deps (#1427 Part 2).
 *
 * Everything is driven with FAKES — a fake AnthropicMessagesClient and a fake
 * MCPAdapter. No API key, no network, no browser. Asserts:
 *   - step() captures the model's tool call into a RunnerStep
 *   - judge() parses well-formed JSON and falls back safely on malformed JSON
 *   - shouldStop() eventually fires via the marginal-utility / early-stop wiring
 */

import type { MCPAdapter, MCPToolResult } from '../../benchmark-runner';
import type { AnthropicMessagesClient } from '../../llm-provider/anthropic-loop';
import {
  createLiveOnlineMind2WebDeps,
  parseJudgeReply,
  CapturingOM2WAdapter,
  DEFAULT_OM2W_MAX_TURNS_PER_STEP,
} from './live-deps';
import type { OnlineMind2WebTask } from './loader';
import type { RunnerStep } from './runner';

function fakeTask(): OnlineMind2WebTask {
  return {
    task_id: 'om2w-fake-1',
    website: 'https://example.com',
    task_description: 'find the login link',
    reference_length: 3,
  };
}

function okResult(text: string): MCPToolResult {
  return { content: [{ type: 'text', text }], isError: false };
}

/** Fake adapter that records calls and always succeeds. */
function fakeAdapter(): MCPAdapter & { calls: Array<{ tool: string; args: Record<string, unknown> }> } {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  return {
    name: 'fake',
    mode: 'dom',
    kind: 'mcp',
    calls,
    async callTool(tool, args) {
      calls.push({ tool, args });
      return okResult(`${tool} done`);
    },
  };
}

/**
 * Fake client: emits one navigate tool call, then a terminal text turn once
 * a tool_result has been threaded back. Distinguishes judge calls by system.
 */
function fakeStepAndJudgeClient(judgeText: string): AnthropicMessagesClient {
  return {
    create: async (input: Record<string, unknown>) => {
      const system = typeof input.system === 'string' ? input.system : '';
      if (system.includes('evaluator')) {
        return {
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: judgeText }],
        };
      }
      const hasToolResult = Array.isArray(input.messages)
        && (input.messages as Array<{ content?: unknown }>).some(
          (m) => Array.isArray(m.content)
            && (m.content as Array<{ type?: string }>).some((c) => c.type === 'tool_result'),
        );
      if (hasToolResult) {
        return {
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: 'done navigating' }],
        };
      }
      return {
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'text', text: 'navigating' },
          { type: 'tool_use', id: 't1', name: 'navigate', input: { url: 'https://example.com' } },
        ],
      };
    },
  };
}

describe('createLiveOnlineMind2WebDeps.step', () => {
  it('captures the model tool call into a RunnerStep', async () => {
    const adapter = fakeAdapter();
    const deps = createLiveOnlineMind2WebDeps({
      client: fakeStepAndJudgeClient('{"passed":true,"reason":"ok"}'),
      adapter,
      maxTurnsPerStep: 4,
      now: () => 0,
    });

    const step = await deps.step(fakeTask(), 1, []);

    expect(step.step).toBe(1);
    expect(step.tool).toBe('navigate');
    expect(step.args).toEqual({ url: 'https://example.com' });
    expect(step.ok).toBe(true);
    expect(step.summary).toContain('navigate done');
    // The adapter actually executed the model's tool call.
    expect(adapter.calls).toEqual([{ tool: 'navigate', args: { url: 'https://example.com' } }]);
  });

  it('records a no-op step when the model emits no tool call', async () => {
    const noToolClient: AnthropicMessagesClient = {
      create: async () => ({
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: 'I cannot proceed.' }],
      }),
    };
    const deps = createLiveOnlineMind2WebDeps({
      client: noToolClient,
      adapter: fakeAdapter(),
      maxTurnsPerStep: 2,
      now: () => 0,
    });
    const step = await deps.step(fakeTask(), 2, []);
    expect(step.tool).toBe('none');
    expect(step.ok).toBe(true);
    expect(step.summary).toBe('I cannot proceed.');
  });

  it('surfaces a budget/iteration abort as a failed step', async () => {
    // A model that never stops emitting tool calls exhausts maxTurns, so the
    // tool-use loop returns aborted:'MAX_ITERATIONS'. The step must be recorded
    // as a failure (not a clean success) so the runner stops and the abort
    // reason reaches the judge's evidence.
    const neverStopsClient: AnthropicMessagesClient = {
      create: async (input: Record<string, unknown>) => {
        const system = typeof input.system === 'string' ? input.system : '';
        if (system.includes('evaluator')) {
          return {
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [{ type: 'text', text: '{"passed":false,"reason":"aborted"}' }],
          };
        }
        return {
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [
            { type: 'text', text: 'still working' },
            { type: 'tool_use', id: 't1', name: 'navigate', input: { url: 'https://example.com' } },
          ],
        };
      },
    };
    const deps = createLiveOnlineMind2WebDeps({
      client: neverStopsClient,
      adapter: fakeAdapter(),
      maxTurnsPerStep: 2,
      now: () => 0,
    });
    const step = await deps.step(fakeTask(), 1, []);
    expect(step.ok).toBe(false);
    expect(step.summary).toContain('step aborted: MAX_ITERATIONS');
  });

  it('bounds a step to the OM2W per-step turn default when none is injected', async () => {
    // A model that always emits another tool call would, without an explicit
    // cap, fall back to WEBVOYAGER_BUDGET.max_tool_iterations (50) per step. The
    // OM2W deps inject DEFAULT_OM2W_MAX_TURNS_PER_STEP instead, so the inner loop
    // makes exactly that many tool calls before aborting MAX_ITERATIONS.
    const adapter = fakeAdapter();
    const neverStopsClient: AnthropicMessagesClient = {
      create: async () => ({
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'text', text: 'again' },
          { type: 'tool_use', id: 't1', name: 'navigate', input: { url: 'https://example.com' } },
        ],
      }),
    };
    const deps = createLiveOnlineMind2WebDeps({
      client: neverStopsClient,
      adapter,
      now: () => 0,
    });
    const step = await deps.step(fakeTask(), 1, []);
    expect(step.ok).toBe(false);
    expect(step.summary).toContain('step aborted: MAX_ITERATIONS');
    expect(adapter.calls).toHaveLength(DEFAULT_OM2W_MAX_TURNS_PER_STEP);
  });

  it('surfaces a USD budget abort as a failed step', async () => {
    // The other abort path: a single turn whose reported token usage blows the
    // per-task USD ceiling (WEBVOYAGER_BUDGET.max_usd_per_task = 0.5; pricing is
    // $15/M output, so 1M output tokens ≈ $15). accountLlmBudget aborts with
    // BUDGET_EXCEEDED before the loop ever inspects the tool calls. The step
    // must be recorded as failed so the runner stops and the abort reason is
    // visible to the judge — same contract as MAX_ITERATIONS, different trigger.
    const overBudgetClient: AnthropicMessagesClient = {
      create: async (input: Record<string, unknown>) => {
        const system = typeof input.system === 'string' ? input.system : '';
        if (system.includes('evaluator')) {
          return {
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [{ type: 'text', text: '{"passed":false,"reason":"aborted"}' }],
          };
        }
        return {
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1_000_000 },
          content: [
            { type: 'text', text: 'expensive turn' },
            { type: 'tool_use', id: 't1', name: 'navigate', input: { url: 'https://example.com' } },
          ],
        };
      },
    };
    const deps = createLiveOnlineMind2WebDeps({
      client: overBudgetClient,
      adapter: fakeAdapter(),
      maxTurnsPerStep: 4,
      now: () => 0,
    });
    const step = await deps.step(fakeTask(), 1, []);
    expect(step.ok).toBe(false);
    expect(step.summary).toContain('step aborted: BUDGET_EXCEEDED');
  });
});

describe('createLiveOnlineMind2WebDeps.judge', () => {
  it('parses a well-formed JSON verdict (happy path)', async () => {
    const deps = createLiveOnlineMind2WebDeps({
      client: fakeStepAndJudgeClient('{"passed":true,"reason":"task complete"}'),
      adapter: fakeAdapter(),
      now: () => 0,
    });
    const verdict = await deps.judge(fakeTask(), []);
    expect(verdict.passed).toBe(true);
    expect(verdict.reason).toBe('task complete');
    expect(verdict.judge_id).toBe('claude-llm-judge');
  });

  it('parses a JSON verdict embedded in prose / code fences', async () => {
    const wrapped = 'Here is my verdict:\n```json\n{"passed": false, "reason": "no evidence"}\n```\nThanks.';
    const deps = createLiveOnlineMind2WebDeps({
      client: fakeStepAndJudgeClient(wrapped),
      adapter: fakeAdapter(),
      now: () => 0,
    });
    const verdict = await deps.judge(fakeTask(), []);
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toBe('no evidence');
  });

  it('falls back to passed:false on malformed JSON', async () => {
    const deps = createLiveOnlineMind2WebDeps({
      client: fakeStepAndJudgeClient('not json at all'),
      adapter: fakeAdapter(),
      now: () => 0,
    });
    const verdict = await deps.judge(fakeTask(), []);
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('not JSON');
    expect(verdict.judge_id).toBe('claude-llm-judge');
  });

  it('falls back to passed:false when the judge invocation throws', async () => {
    const throwingClient: AnthropicMessagesClient = {
      create: async () => {
        throw new Error('network down');
      },
    };
    const deps = createLiveOnlineMind2WebDeps({
      client: throwingClient,
      adapter: fakeAdapter(),
      now: () => 0,
    });
    const verdict = await deps.judge(fakeTask(), []);
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('judge invocation failed');
  });
});

describe('parseJudgeReply', () => {
  it('rejects an object missing the boolean passed field', () => {
    const v = parseJudgeReply('{"reason":"hmm"}');
    expect(v.passed).toBe(false);
    expect(v.reason).toContain('missing boolean');
  });

  it('handles empty input', () => {
    const v = parseJudgeReply('');
    expect(v.passed).toBe(false);
    expect(v.reason).toContain('empty');
  });

  it('defaults the reason when omitted but passed is present', () => {
    const v = parseJudgeReply('{"passed": true}');
    expect(v.passed).toBe(true);
    expect(v.reason).toBe('no reason provided');
  });

  it('extracts the verdict object even when prose contains stray braces', () => {
    const reply = 'Consider the criteria {accuracy, recall} first.\n{"passed": true, "reason": "login link clicked"}';
    const v = parseJudgeReply(reply);
    expect(v.passed).toBe(true);
    expect(v.reason).toBe('login link clicked');
  });

  it('does not mis-slice when a brace appears inside a string value', () => {
    const v = parseJudgeReply('{"passed": false, "reason": "saw text like {x} on page"}');
    expect(v.passed).toBe(false);
    expect(v.reason).toBe('saw text like {x} on page');
  });
});

describe('createLiveOnlineMind2WebDeps.shouldStop', () => {
  function okStep(i: number): RunnerStep {
    return { step: i, tool: 'read_page', args: {}, ok: true, summary: 'ok' };
  }

  it('does not stop on an empty history', () => {
    const deps = createLiveOnlineMind2WebDeps({
      client: fakeStepAndJudgeClient('{"passed":true,"reason":"ok"}'),
      adapter: fakeAdapter(),
      now: () => 0,
    });
    expect(deps.shouldStop?.([])).toBe(false);
  });

  it('does not stop early before the plateau accumulates', () => {
    const deps = createLiveOnlineMind2WebDeps({
      client: fakeStepAndJudgeClient('{"passed":true,"reason":"ok"}'),
      adapter: fakeAdapter(),
      now: () => 0,
    });
    const history = Array.from({ length: 3 }, (_v, i) => okStep(i + 1));
    expect(deps.shouldStop?.(history)).toBe(false);
  });

  it('recommends stop once p_success plateaus over a long all-ok history', () => {
    const deps = createLiveOnlineMind2WebDeps({
      client: fakeStepAndJudgeClient('{"passed":true,"reason":"ok"}'),
      adapter: fakeAdapter(),
      now: () => 0,
    });
    // All-ok steps drive step_score=0.7; p_success converges to 0.7 and the
    // deltas fall below the tracker's low-delta threshold, accumulating a
    // plateau that satisfies the default early-stop policy.
    const history = Array.from({ length: 40 }, (_v, i) => okStep(i + 1));
    expect(deps.shouldStop?.(history)).toBe(true);
  });
});

describe('CapturingOM2WAdapter', () => {
  it('mirrors inner adapter identity and resets capture between steps', async () => {
    const inner = fakeAdapter();
    const wrapper = new CapturingOM2WAdapter(inner);
    expect(wrapper.name).toBe('fake');
    expect(wrapper.mode).toBe('dom');

    await wrapper.callTool('navigate', { url: 'https://a.test' });
    expect(wrapper.capturedCalls()).toHaveLength(1);
    wrapper.resetStepCapture();
    expect(wrapper.capturedCalls()).toHaveLength(0);
  });
});
