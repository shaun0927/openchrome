/**
 * Console Capture Tool - Capture and manage browser console logs
 */

import { ConsoleMessage, Page } from 'puppeteer-core';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

// Console log entry structure
interface ConsoleLogEntry {
  type: string;
  text: string;
  timestamp: number;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
  args?: string[];
}

// Capture state for each tab
interface CaptureState {
  logs: ConsoleLogEntry[];
  listener: (msg: ConsoleMessage) => void;
  startedAt: number;
  filter?: string[];
  maxLogs: number;
}

// Module-level state storage
const captureStates: Map<string, CaptureState> = new Map();

const definition: MCPToolDefinition = {
  name: 'console_capture',
  description: `Capture and manage browser console logs.
Actions:
- "start": Start capturing console logs
- "stop": Stop capturing and remove listener
- "get": Get captured logs
- "clear": Clear captured logs without stopping`,
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to capture console logs from',
      },
      action: {
        type: 'string',
        enum: ['start', 'stop', 'get', 'clear'],
        description: 'Action to perform',
      },
      filter: {
        type: 'array',
        items: { type: 'string' },
        description: 'Log types to capture: log, warn, error, info, debug (default: all)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of logs to return (for "get" action)',
      },
      maxLogs: {
        type: 'number',
        description: 'Maximum logs to store (for "start" action, default: 1000)',
      },
    },
    required: ['tabId', 'action'],
  },
};

// Cleanup listener when session ends
const setupCleanupListener = (() => {
  let initialized = false;
  return () => {
    if (initialized) return;
    initialized = true;

    const sessionManager = getSessionManager();
    sessionManager.addEventListener((event) => {
      if (
        event.type === 'session:target-closed' ||
        event.type === 'session:target-removed'
      ) {
        const targetId = event.targetId;
        if (targetId) {
          const state = captureStates.get(targetId);
          if (state) {
            captureStates.delete(targetId);
            console.error(`[ConsoleCapture] Cleaned up capture state for closed tab ${targetId}`);
          }
        }
      }
    });
  };
})();

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const action = args.action as string;
  const filter = args.filter as string[] | undefined;
  const limit = args.limit as number | undefined;
  const maxLogs = (args.maxLogs as number | undefined) ?? 1000;

  const sessionManager = getSessionManager();

  // Setup cleanup listener on first use
  setupCleanupListener();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!action) {
    return {
      content: [{ type: 'text', text: 'Error: action is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId);
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    switch (action) {
      case 'start': {
        // Check if already capturing
        if (captureStates.has(tabId)) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'start',
                  status: 'already_capturing',
                  message: 'Console capture already running for this tab',
                }),
              },
            ],
          };
        }

        // Create listener
        const state: CaptureState = {
          logs: [],
          listener: () => {},
          startedAt: Date.now(),
          filter,
          maxLogs,
        };

        state.listener = (msg: ConsoleMessage) => {
          const logType = msg.type();

          // Apply filter if specified
          if (filter && filter.length > 0 && !filter.includes(logType)) {
            return;
          }

          const location = msg.location();
          const entry: ConsoleLogEntry = {
            type: logType,
            text: msg.text(),
            timestamp: Date.now(),
            location: location
              ? {
                  url: location.url,
                  lineNumber: location.lineNumber,
                  columnNumber: location.columnNumber,
                }
              : undefined,
          };

          // Try to serialize args
          try {
            entry.args = msg.args().map((arg) => {
              try {
                return arg.toString();
              } catch {
                return '[unable to serialize]';
              }
            });
          } catch {
            // Ignore serialization errors
          }

          state.logs.push(entry);

          // Trim if exceeds max
          if (state.logs.length > state.maxLogs) {
            state.logs = state.logs.slice(-state.maxLogs);
          }
        };

        page.on('console', state.listener);
        captureStates.set(tabId, state);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                status: 'started',
                filter: filter || 'all',
                maxLogs,
                message: `Console capture started for tab ${tabId}`,
              }),
            },
          ],
        };
      }

      case 'stop': {
        const state = captureStates.get(tabId);
        if (!state) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'stop',
                  status: 'not_running',
                  message: 'Console capture was not running for this tab',
                }),
              },
            ],
          };
        }

        // Remove listener
        page.off('console', state.listener);
        const logCount = state.logs.length;
        const duration = Date.now() - state.startedAt;
        captureStates.delete(tabId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'stop',
                status: 'stopped',
                capturedLogs: logCount,
                durationMs: duration,
                message: `Console capture stopped. Captured ${logCount} logs over ${Math.round(duration / 1000)}s`,
              }),
            },
          ],
        };
      }

      case 'get': {
        const state = captureStates.get(tabId);
        if (!state) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'get',
                  status: 'not_running',
                  logs: [],
                  message: 'Console capture is not running for this tab',
                }),
              },
            ],
          };
        }

        let logs = state.logs;
        if (limit && limit > 0) {
          logs = logs.slice(-limit);
        }

        // Calculate stats
        const stats = {
          total: state.logs.length,
          returned: logs.length,
          byType: {} as Record<string, number>,
        };
        for (const log of state.logs) {
          stats.byType[log.type] = (stats.byType[log.type] || 0) + 1;
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'get',
                status: 'running',
                logs,
                stats,
                durationMs: Date.now() - state.startedAt,
              }),
            },
          ],
        };
      }

      case 'clear': {
        const state = captureStates.get(tabId);
        if (!state) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'clear',
                  status: 'not_running',
                  message: 'Console capture is not running for this tab',
                }),
              },
            ],
          };
        }

        const clearedCount = state.logs.length;
        state.logs = [];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'clear',
                status: 'cleared',
                clearedCount,
                message: `Cleared ${clearedCount} logs`,
              }),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown action "${action}". Use: start, stop, get, or clear`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Console capture error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerConsoleCaptureTool(server: MCPServer): void {
  server.registerTool('console_capture', handler, definition);
}
