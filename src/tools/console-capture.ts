/**
 * Console Capture Tool - Capture and manage browser console logs
 *
 * Uses CDP Runtime.consoleAPICalled + Runtime.exceptionThrown directly
 * instead of Puppeteer's page.on('console'), because rebrowser-puppeteer-core
 * skips Runtime.enable to avoid bot detection. We enable it on a dedicated
 * CDPSession so console events are reliably captured.
 */

import { CDPSession, Page } from 'puppeteer-core';
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

// CDP event payload types
interface CDPConsoleAPICalledEvent {
  type: string;
  args: Array<{ type: string; value?: unknown; description?: string; preview?: { properties?: Array<{ value?: string }> } }>;
  executionContextId: number;
  timestamp: number;
  stackTrace?: {
    callFrames: Array<{
      url: string;
      lineNumber: number;
      columnNumber: number;
    }>;
  };
}

interface CDPExceptionThrownEvent {
  timestamp: number;
  exceptionDetails: {
    text: string;
    exception?: { description?: string; value?: unknown };
    lineNumber?: number;
    columnNumber?: number;
    url?: string;
    stackTrace?: {
      callFrames: Array<{
        url: string;
        lineNumber: number;
        columnNumber: number;
      }>;
    };
  };
}

// Capture state for each tab
interface CaptureState {
  logs: ConsoleLogEntry[];
  cdpSession: CDPSession;
  consoleHandler: (event: CDPConsoleAPICalledEvent) => void;
  exceptionHandler: (event: CDPExceptionThrownEvent) => void;
  startedAt: number;
  filter?: string[];
  maxLogs: number;
}

// Module-level state storage
const captureStates: Map<string, CaptureState> = new Map();

// Deduplicated log entry (returned in get responses)
interface DedupedLogEntry {
  type: string;
  text: string;
  count: number;
  firstTimestamp?: number;
  lastTimestamp?: number;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
  args?: string[];
}

/**
 * Collapse consecutive identical log messages into single entries with a count.
 * Error and warning types are NEVER deduplicated — always shown individually.
 * Only groups of 3+ identical consecutive messages are collapsed.
 */
function deduplicateLogs(logs: ConsoleLogEntry[]): DedupedLogEntry[] {
  const result: DedupedLogEntry[] = [];
  let i = 0;
  while (i < logs.length) {
    const current = logs[i];

    // NEVER deduplicate error or warning types — always show individually
    if (current.type === 'error' || current.type === 'warning') {
      result.push({
        type: current.type,
        text: current.text,
        count: 1,
        firstTimestamp: current.timestamp,
        lastTimestamp: current.timestamp,
        location: current.location,
        args: current.args,
      });
      i++;
      continue;
    }

    // Count consecutive identical messages (same text AND same type)
    let count = 1;
    while (
      i + count < logs.length &&
      logs[i + count].text === current.text &&
      logs[i + count].type === current.type
    ) {
      count++;
    }

    if (count >= 3) {
      // Collapse into single entry with count
      result.push({
        text: current.text,
        type: current.type,
        count,
        firstTimestamp: current.timestamp,
        lastTimestamp: logs[i + count - 1].timestamp,
        location: current.location,
        args: current.args,
      });
    } else {
      // Show individually
      for (let j = 0; j < count; j++) {
        const entry = logs[i + j];
        result.push({
          type: entry.type,
          text: entry.text,
          count: 1,
          firstTimestamp: entry.timestamp,
          lastTimestamp: entry.timestamp,
          location: entry.location,
          args: entry.args,
        });
      }
    }
    i += count;
  }
  return result;
}

const definition: MCPToolDefinition = {
  name: 'console_capture',
  description: 'Capture browser console output (start, stop, get, clear).',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID',
      },
      action: {
        type: 'string',
        enum: ['start', 'stop', 'get', 'clear'],
        description: 'Action to perform',
      },
      filter: {
        type: 'array',
        items: { type: 'string' },
        description: 'Log types to capture. Default: all',
      },
      limit: {
        type: 'number',
        description: 'Max logs to return (get action)',
      },
      maxLogs: {
        type: 'number',
        description: 'Max logs to store. Default: 1000',
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
            state.cdpSession.detach().catch(() => {});
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
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'console_capture');
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

        // Create a dedicated CDP session and enable Runtime domain
        // so we receive consoleAPICalled and exceptionThrown events.
        // rebrowser-puppeteer-core skips Runtime.enable by default,
        // so Puppeteer's page.on('console') never fires.
        const cdpSession = await page.createCDPSession();
        await cdpSession.send('Runtime.enable');

        const state: CaptureState = {
          logs: [],
          cdpSession,
          consoleHandler: () => {},
          exceptionHandler: () => {},
          startedAt: Date.now(),
          filter,
          maxLogs,
        };

        // Map CDP console types to Puppeteer-style types
        const mapType = (cdpType: string): string => {
          // CDP uses 'warning' but Puppeteer normalizes to 'warn' in some versions
          if (cdpType === 'warning') return 'warning';
          return cdpType;
        };

        state.consoleHandler = (event: CDPConsoleAPICalledEvent) => {
          const logType = mapType(event.type);

          // Apply filter if specified
          if (filter && filter.length > 0 && !filter.includes(logType)) {
            return;
          }

          const callFrame = event.stackTrace?.callFrames?.[0];
          const text = event.args
            .map((arg) => {
              if (arg.value !== undefined) return String(arg.value);
              if (arg.description) return arg.description;
              return `[${arg.type}]`;
            })
            .join(' ');

          const entry: ConsoleLogEntry = {
            type: logType,
            text,
            timestamp: Date.now(),
            location: callFrame
              ? {
                  url: callFrame.url,
                  lineNumber: callFrame.lineNumber,
                  columnNumber: callFrame.columnNumber,
                }
              : undefined,
            args: event.args.map((arg) => {
              if (arg.value !== undefined) return String(arg.value);
              if (arg.description) return arg.description;
              return `[${arg.type}]`;
            }),
          };

          state.logs.push(entry);

          // Trim if exceeds max
          if (state.logs.length > state.maxLogs) {
            state.logs = state.logs.slice(-state.maxLogs);
          }
        };

        // Capture unhandled promise rejections
        state.exceptionHandler = (event: CDPExceptionThrownEvent) => {
          const details = event.exceptionDetails;

          // Apply filter — map exceptions to 'error' type
          if (filter && filter.length > 0 && !filter.includes('error')) {
            return;
          }

          const text =
            details.exception?.description ||
            details.exception?.value?.toString() ||
            details.text ||
            'Unknown error';
          const callFrame = details.stackTrace?.callFrames?.[0];

          const entry: ConsoleLogEntry = {
            type: 'error',
            text,
            timestamp: Date.now(),
            location: callFrame
              ? {
                  url: callFrame.url,
                  lineNumber: callFrame.lineNumber,
                  columnNumber: callFrame.columnNumber,
                }
              : details.url
                ? { url: details.url, lineNumber: details.lineNumber, columnNumber: details.columnNumber }
                : undefined,
          };

          state.logs.push(entry);

          if (state.logs.length > state.maxLogs) {
            state.logs = state.logs.slice(-state.maxLogs);
          }
        };

        cdpSession.on('Runtime.consoleAPICalled', state.consoleHandler as any);
        cdpSession.on('Runtime.exceptionThrown', state.exceptionHandler as any);
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

        // Remove CDP listeners and detach session
        state.cdpSession.off('Runtime.consoleAPICalled', state.consoleHandler as any);
        state.cdpSession.off('Runtime.exceptionThrown', state.exceptionHandler as any);
        await state.cdpSession.send('Runtime.disable').catch(() => {});
        await state.cdpSession.detach().catch(() => {});
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

        // Deduplicate consecutive identical log messages
        const deduplicatedLogs = deduplicateLogs(logs);

        // Calculate stats
        const stats = {
          total: state.logs.length,
          returned: deduplicatedLogs.length,
          beforeDedup: logs.length,
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
                logs: deduplicatedLogs,
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
