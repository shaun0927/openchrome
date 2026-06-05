/** oc_progress_status — read-only anti-wandering diagnostics (#1060). */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getActivityTracker } from '../dashboard/activity-tracker';
import { buildProgressStatus } from '../progress/progress-status';

const DEFAULT_WINDOW = 10;
const MIN_WINDOW = 3;
const MAX_WINDOW = 50;

function parseWindow(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_WINDOW;
  return Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, n));
}

const definition: MCPToolDefinition = {
  name: 'oc_progress_status',
  annotations: TOOL_ANNOTATIONS.oc_progress_status,
  description:
    'Read-only diagnostics for whether the current OpenChrome session appears to be progressing, stalling, or stuck. ' +
    'Returns bounded counters and advisory next-call suggestions; it never stops, retries, recovers, or executes browser actions.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Optional session ID. Defaults to the current MCP session.' },
      window: { type: 'number', description: `Recent completed calls to inspect. Default ${DEFAULT_WINDOW}, min ${MIN_WINDOW}, max ${MAX_WINDOW}.` },
      includeRecentCalls: { type: 'boolean', description: 'Include redacted compact recent call summaries. Default false.' },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      status: { type: 'string', enum: ['progressing', 'stalling', 'stuck'] },
      window: { type: 'number' },
      counters: { type: 'object' },
      topSignal: { type: 'object' },
      suggestedPolicy: { type: 'string' },
      suggestedNextCalls: { type: 'array', items: { type: 'object' } },
      recentCalls: { type: 'array', items: { type: 'object' } },
    },
    required: ['sessionId', 'status', 'window', 'counters', 'suggestedPolicy', 'suggestedNextCalls'],
  },
};

const handler: ToolHandler = async (currentSessionId, args): Promise<MCPResult> => {
  const sessionId = (args.sessionId as string | undefined) || currentSessionId || 'default';
  const window = parseWindow(args.window);
  const includeRecentCalls = args.includeRecentCalls === true;
  const calls = getActivityTracker().getRecentCalls(window, sessionId);
  const structured = buildProgressStatus({ sessionId, calls, window, includeRecentCalls });
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured as unknown as Record<string, unknown>,
  };
};

export function registerOcProgressStatusTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
