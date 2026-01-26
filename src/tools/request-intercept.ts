/**
 * Request Intercept Tool - Intercept and modify network requests
 */

import { HTTPRequest, Page } from 'puppeteer-core';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

// Intercept rule definition
interface InterceptRule {
  id: string;
  pattern: string;
  resourceTypes?: string[];
  action: 'block' | 'modify' | 'log';
  modifyOptions?: {
    headers?: Record<string, string>;
    body?: string;
    status?: number;
  };
}

// Logged request entry
interface RequestLogEntry {
  url: string;
  resourceType: string;
  method: string;
  headers: Record<string, string>;
  timestamp: number;
  matched: boolean;
  ruleId?: string;
}

// Intercept state for each tab
interface InterceptState {
  enabled: boolean;
  rules: InterceptRule[];
  listener: ((request: HTTPRequest) => void) | null;
  loggedRequests: RequestLogEntry[];
  maxLogs: number;
}

// Module-level state storage
const interceptStates: Map<string, InterceptState> = new Map();

// Helper function to match URL patterns (glob-like)
function matchesPattern(url: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${regexPattern}$`, 'i').test(url);
  } catch {
    return url.includes(pattern);
  }
}

const definition: MCPToolDefinition = {
  name: 'request_intercept',
  description: `Intercept and control network requests.
Actions:
- "enable": Enable request interception
- "disable": Disable request interception
- "addRule": Add an intercept rule
- "removeRule": Remove a rule by ID
- "listRules": List all active rules
- "getLogs": Get logged requests
- "clearLogs": Clear request logs

Rule actions: "block" (abort request), "modify" (change response), "log" (just log)`,
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to intercept requests for',
      },
      action: {
        type: 'string',
        enum: ['enable', 'disable', 'addRule', 'removeRule', 'listRules', 'getLogs', 'clearLogs'],
        description: 'Action to perform',
      },
      rule: {
        type: 'object',
        description: 'Rule definition for addRule action',
        properties: {
          pattern: {
            type: 'string',
            description: 'URL pattern to match (glob-like, e.g., "*://example.com/*")',
          },
          resourceTypes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Resource types: document, stylesheet, image, font, script, xhr, fetch',
          },
          action: {
            type: 'string',
            enum: ['block', 'modify', 'log'],
            description: 'What to do with matched requests',
          },
          modifyOptions: {
            type: 'object',
            description: 'Options for modify action',
            properties: {
              status: { type: 'number' },
              headers: { type: 'object' },
              body: { type: 'string' },
            },
          },
        },
      },
      ruleId: {
        type: 'string',
        description: 'Rule ID for removeRule action',
      },
      limit: {
        type: 'number',
        description: 'Maximum logs to return for getLogs action',
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
          interceptStates.delete(targetId);
          console.error(`[RequestIntercept] Cleaned up state for closed tab ${targetId}`);
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
  const ruleArg = args.rule as {
    pattern?: string;
    resourceTypes?: string[];
    action?: 'block' | 'modify' | 'log';
    modifyOptions?: { status?: number; headers?: Record<string, string>; body?: string };
  } | undefined;
  const ruleId = args.ruleId as string | undefined;
  const limit = args.limit as number | undefined;

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

    // Get or create state
    let state = interceptStates.get(tabId);
    if (!state) {
      state = {
        enabled: false,
        rules: [],
        listener: null,
        loggedRequests: [],
        maxLogs: 500,
      };
      interceptStates.set(tabId, state);
    }

    switch (action) {
      case 'enable': {
        if (state.enabled) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'enable',
                  status: 'already_enabled',
                  rulesCount: state.rules.length,
                }),
              },
            ],
          };
        }

        await page.setRequestInterception(true);

        // Create request listener
        state.listener = async (request: HTTPRequest) => {
          const url = request.url();
          const resourceType = request.resourceType();

          let matched = false;
          let matchedRule: InterceptRule | null = null;

          // Check rules in order
          for (const rule of state!.rules) {
            if (matchesPattern(url, rule.pattern)) {
              // Check resource type filter
              if (rule.resourceTypes && rule.resourceTypes.length > 0) {
                if (!rule.resourceTypes.includes(resourceType)) {
                  continue;
                }
              }

              matched = true;
              matchedRule = rule;
              break;
            }
          }

          // Log request if any log rules exist or matched
          const shouldLog = matched || state!.rules.some(r => r.action === 'log');
          if (shouldLog) {
            state!.loggedRequests.push({
              url: url.slice(0, 200),
              resourceType,
              method: request.method(),
              headers: request.headers(),
              timestamp: Date.now(),
              matched,
              ruleId: matchedRule?.id,
            });

            // Trim logs
            if (state!.loggedRequests.length > state!.maxLogs) {
              state!.loggedRequests = state!.loggedRequests.slice(-state!.maxLogs);
            }
          }

          // Apply rule action
          if (matchedRule) {
            try {
              if (matchedRule.action === 'block') {
                await request.abort('blockedbyclient');
                return;
              }

              if (matchedRule.action === 'modify' && matchedRule.modifyOptions) {
                await request.respond({
                  status: matchedRule.modifyOptions.status || 200,
                  headers: matchedRule.modifyOptions.headers || {},
                  body: matchedRule.modifyOptions.body || '',
                });
                return;
              }
            } catch (e) {
              // Request might already be handled
            }
          }

          // Continue with request
          try {
            await request.continue();
          } catch {
            // Request might already be handled
          }
        };

        page.on('request', state.listener);
        state.enabled = true;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'enable',
                status: 'enabled',
                rulesCount: state.rules.length,
                message: 'Request interception enabled',
              }),
            },
          ],
        };
      }

      case 'disable': {
        if (!state.enabled) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'disable',
                  status: 'already_disabled',
                }),
              },
            ],
          };
        }

        if (state.listener) {
          page.off('request', state.listener);
          state.listener = null;
        }

        await page.setRequestInterception(false);
        state.enabled = false;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'disable',
                status: 'disabled',
                message: 'Request interception disabled',
              }),
            },
          ],
        };
      }

      case 'addRule': {
        if (!ruleArg || !ruleArg.pattern || !ruleArg.action) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: rule with pattern and action is required',
              },
            ],
            isError: true,
          };
        }

        const newRule: InterceptRule = {
          id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          pattern: ruleArg.pattern,
          resourceTypes: ruleArg.resourceTypes,
          action: ruleArg.action,
          modifyOptions: ruleArg.modifyOptions,
        };

        state.rules.push(newRule);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'addRule',
                rule: newRule,
                totalRules: state.rules.length,
                message: `Added rule ${newRule.id}`,
              }),
            },
          ],
        };
      }

      case 'removeRule': {
        if (!ruleId) {
          return {
            content: [{ type: 'text', text: 'Error: ruleId is required' }],
            isError: true,
          };
        }

        const index = state.rules.findIndex((r) => r.id === ruleId);
        if (index === -1) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'removeRule',
                  status: 'not_found',
                  message: `Rule ${ruleId} not found`,
                }),
              },
            ],
          };
        }

        state.rules.splice(index, 1);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'removeRule',
                removedId: ruleId,
                remainingRules: state.rules.length,
                message: `Removed rule ${ruleId}`,
              }),
            },
          ],
        };
      }

      case 'listRules': {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'listRules',
                enabled: state.enabled,
                rules: state.rules,
                count: state.rules.length,
              }),
            },
          ],
        };
      }

      case 'getLogs': {
        let logs = state.loggedRequests;
        if (limit && limit > 0) {
          logs = logs.slice(-limit);
        }

        // Calculate stats
        const stats = {
          total: state.loggedRequests.length,
          returned: logs.length,
          blocked: state.loggedRequests.filter(l => l.matched).length,
          byType: {} as Record<string, number>,
        };
        for (const log of state.loggedRequests) {
          stats.byType[log.resourceType] = (stats.byType[log.resourceType] || 0) + 1;
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'getLogs',
                logs,
                stats,
              }),
            },
          ],
        };
      }

      case 'clearLogs': {
        const clearedCount = state.loggedRequests.length;
        state.loggedRequests = [];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'clearLogs',
                clearedCount,
                message: `Cleared ${clearedCount} request logs`,
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
              text: `Error: Unknown action "${action}"`,
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
          text: `Request intercept error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerRequestInterceptTool(server: MCPServer): void {
  server.registerTool('request_intercept', handler, definition);
}
