/** oc_vitals — read-only Web Vitals snapshot (#840). */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { withTimeout } from '../utils/with-timeout';
import { collectWebVitalsInPage, normalizeWebVitals, RawWebVitals } from '../core/perf/web-vitals-collector';

const definition: MCPToolDefinition = {
  name: 'oc_vitals',
  annotations: TOOL_ANNOTATIONS.oc_vitals,
  description:
    'Collect a read-only Web Vitals snapshot from the current page without adding page scripts or package dependencies. ' +
    'Returns LCP, CLS, INP, TTFB, and FCP with Core Web Vitals ratings where browser timing entries are available.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'REQUIRED Tab ID to collect Web Vitals from.' },
      timeoutMs: { type: 'number', description: 'Maximum collection time in ms. Default 5000, min 100, max 30000.' },
    },
    required: ['tabId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      tabId: { type: 'string' },
      vitals: { type: 'object' },
      source: { type: 'string' },
      noDependency: { type: 'boolean' },
    },
    required: ['action', 'tabId', 'vitals', 'source', 'noDependency'],
  },
};

function parseTimeoutMs(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 5000;
  return Math.min(30000, Math.max(100, n));
}

const handler: ToolHandler = async (sessionId: string, args: Record<string, unknown>): Promise<MCPResult> => {
  const tabId = args.tabId as string | undefined;
  if (!tabId) {
    return { content: [{ type: 'text', text: 'Error: tabId is required' }], isError: true };
  }

  try {
    const sessionManager = getSessionManager();
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'oc_vitals');
    if (!page) {
      return { content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }], isError: true };
    }

    const raw = await withTimeout(
      page.evaluate(collectWebVitalsInPage) as Promise<RawWebVitals>,
      parseTimeoutMs(args.timeoutMs),
      'oc_vitals',
    );
    const structured = {
      action: 'oc_vitals',
      tabId,
      vitals: normalizeWebVitals(raw),
      source: 'performance_entries',
      noDependency: true,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `oc_vitals error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};

export function registerOcVitalsTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
