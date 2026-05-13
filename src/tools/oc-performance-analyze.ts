/**
 * oc_performance_analyze — Step 2 of the two-step performance flow (#846).
 *
 * Drills into one named insight from a previously captured trace. The
 * `trace_id` argument is a handle returned by `oc_performance_insights`;
 * the `insight` argument must be one of the closed-set names exported
 * by the v1 engine. Unknown insight names return a structured
 * `{ error: 'unknown_insight', supported: [...] }` so the agent can
 * recover without crashing the server.
 *
 * Tier: core. Off-switch: `OPENCHROME_PERF_INSIGHTS=0` skips registration.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import {
  INSIGHT_NAMES,
  evaluateInsights,
  isInsightName,
} from '../core/performance/insights';
import { getPerfTraceStore } from '../core/performance/insights/trace-store';

const definition: MCPToolDefinition = {
  name: 'oc_performance_analyze',
  description:
    'Drill into one named insight from a trace captured by ' +
    'oc_performance_insights. Returns Markdown details and an evidence ' +
    'list. Unknown insight names return ' +
    "{ error: 'unknown_insight', supported: [...] } without crashing.",
  inputSchema: {
    type: 'object',
    properties: {
      trace_id: {
        type: 'string',
        description: 'REQUIRED Trace handle returned by oc_performance_insights.',
      },
      insight: {
        type: 'string',
        enum: [...INSIGHT_NAMES],
        description: 'REQUIRED Name of the insight to drill into.',
      },
    },
    required: ['trace_id', 'insight'],
  },
};

function jsonResult(payload: Record<string, unknown>, opts?: { isError?: boolean }): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...payload,
    ...(opts?.isError ? { isError: true } : {}),
  };
}

const handler: ToolHandler = async (
  sessionId: string,
  rawArgs: Record<string, unknown>,
): Promise<MCPResult> => {
  const traceId = typeof rawArgs.trace_id === 'string' ? rawArgs.trace_id : '';
  const insight = typeof rawArgs.insight === 'string' ? rawArgs.insight : '';

  if (!traceId) {
    return jsonResult({ error: 'trace_id is required' }, { isError: true });
  }
  if (!insight) {
    return jsonResult(
      { error: 'unknown_insight', supported: [...INSIGHT_NAMES] },
      { isError: true },
    );
  }
  if (!isInsightName(insight)) {
    // Closed-set protection — the agent gets the supported list back so
    // it can self-correct instead of guessing more names.
    return jsonResult(
      { error: 'unknown_insight', supported: [...INSIGHT_NAMES] },
      { isError: true },
    );
  }

  const store = getPerfTraceStore();
  const handle = store.getHandle(traceId);
  // Session ownership check: trace handles are session-scoped. If the
  // handle is missing OR belongs to a different session, return the
  // same `unknown_trace_id` error so cross-session probers cannot
  // confirm the existence of another session's trace.
  if (!handle || handle.session_id !== sessionId) {
    return jsonResult(
      { error: 'unknown_trace_id', trace_id: traceId },
      { isError: true },
    );
  }

  let trace;
  try {
    trace = store.load(traceId);
  } catch (err) {
    return jsonResult(
      {
        error: 'trace_load_failed',
        trace_id: traceId,
        message: err instanceof Error ? err.message : String(err),
      },
      { isError: true },
    );
  }

  const { details } = evaluateInsights(trace);
  const result = details[insight];
  return jsonResult({
    insight: result.insight,
    details_md: result.details_md,
    evidence: result.evidence,
  });
};

export function registerOcPerformanceAnalyzeTool(server: MCPServer): void {
  server.registerTool('oc_performance_analyze', handler, definition);
}
