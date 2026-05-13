/**
 * Tabs Context Tool - Get context about browser tabs
 */

import { MCPServer } from '../mcp-server';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { safeTitle } from '../utils/safe-title';

const definition: MCPToolDefinition = {
  name: 'tabs_context',
  description: 'Get session tab IDs grouped by worker.',
  annotations: TOOL_ANNOTATIONS.tabs_context,
  inputSchema: {
    type: 'object',
    properties: {
      workerId: {
        type: 'string',
        description: 'Filter to a specific worker',
      },
      summary: {
        type: 'boolean',
        description: 'Return counts only, no tab details',
      },
    },
    required: [],
  },
  // #871 — MCP-spec outputSchema. Clients with schema validators (Inspector,
  // future TS SDK-backed hosts) read `structuredContent` directly instead of
  // re-parsing `content[0].text`.
  outputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      defaultWorkerId: { type: 'string' },
      workerCount: { type: 'integer', minimum: 0 },
      tabCount: { type: 'integer', minimum: 0 },
      workers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            tabCount: { type: 'integer', minimum: 0 },
            tabs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  tabId: { type: 'string' },
                  workerId: { type: 'string' },
                  url: { type: 'string' },
                  title: { type: 'string' },
                },
                required: ['tabId', 'workerId', 'url', 'title'],
              },
            },
          },
          required: ['id', 'name', 'tabCount'],
        },
      },
    },
    required: ['sessionId', 'workerCount', 'tabCount', 'workers'],
  },
};

interface TabInfo {
  tabId: string;
  workerId: string;
  url: string;
  title: string;
  /** #848: name of the BrowserContext owning this tab; 'default' for Chrome's default. */
  context: string;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const sessionManager = getSessionManager();
  const requestedWorkerId = args.workerId as string | undefined;
  const summaryMode = args.summary as boolean | undefined;

  try {
    const session = await sessionManager.getOrCreateSession(sessionId);
    const workers = sessionManager.getWorkers(sessionId);

    // Get tab info grouped by worker
    const tabInfos: TabInfo[] = [];
    const workerTabs: Record<string, TabInfo[]> = {};

    for (const workerInfo of workers) {
      // Skip if specific worker requested and this isn't it
      if (requestedWorkerId && workerInfo.id !== requestedWorkerId) {
        continue;
      }

      const targetIds = sessionManager.getWorkerTargetIds(sessionId, workerInfo.id);
      workerTabs[workerInfo.id] = [];

      for (const targetId of targetIds) {
        try {
          const page = await sessionManager.getPage(sessionId, targetId, workerInfo.id, 'tabs_context');
          if (page) {
            const tabInfo: TabInfo = {
              tabId: targetId,
              workerId: workerInfo.id,
              url: page.url(),
              title: await safeTitle(page),
              context: sessionManager.getTargetContextName(targetId),
            };
            tabInfos.push(tabInfo);
            workerTabs[workerInfo.id].push(tabInfo);
          }
        } catch {
          // Target may have been closed, skip it
        }
      }
    }

    // #871 — single source of truth: build the structured object once, then
    // serialize it for the back-compat `content[]` channel. The wire-format
    // invariant `JSON.parse(content[0].text) === structuredContent` is enforced
    // by tests/unit/output-schema.test.ts.
    const structured = summaryMode
      ? {
          sessionId,
          workerCount: workers.length,
          tabCount: tabInfos.length,
          workers: workers.map((w) => ({
            id: w.id,
            name: w.name,
            tabCount: workerTabs[w.id]?.length || 0,
          })),
        }
      : {
          sessionId,
          defaultWorkerId: session.defaultWorkerId,
          workerCount: workers.length,
          tabCount: tabInfos.length,
          workers: workers.map((w) => ({
            id: w.id,
            name: w.name,
            tabCount: workerTabs[w.id]?.length || 0,
            tabs: workerTabs[w.id] || [],
          })),
        };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(structured),
        },
      ],
      structuredContent: structured as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting tab context: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerTabsContextTool(server: MCPServer): void {
  server.registerTool('tabs_context', handler, definition);
}
