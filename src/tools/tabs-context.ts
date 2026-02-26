/**
 * Tabs Context Tool - Get context about browser tabs
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { safeTitle } from '../utils/safe-title';

const definition: MCPToolDefinition = {
  name: 'tabs_context_mcp',
  description:
    'Get context information about the current MCP session tabs and workers. Returns all tab IDs grouped by worker.',
  inputSchema: {
    type: 'object',
    properties: {
      workerId: {
        type: 'string',
        description: 'Optional: Get tabs for a specific worker only.',
      },
    },
    required: [],
  },
};

interface TabInfo {
  tabId: string;
  workerId: string;
  url: string;
  title: string;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const sessionManager = getSessionManager();
  const requestedWorkerId = args.workerId as string | undefined;

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
            };
            tabInfos.push(tabInfo);
            workerTabs[workerInfo.id].push(tabInfo);
          }
        } catch {
          // Target may have been closed, skip it
        }
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
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
            },
            null,
            2
          ),
        },
      ],
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
  server.registerTool('tabs_context_mcp', handler, definition);
}
