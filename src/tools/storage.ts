/**
 * Storage Tool - Manage localStorage and sessionStorage
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { assertDomainAllowed } from '../security/domain-guard';
import { withTimeout } from '../utils/with-timeout';

const definition: MCPToolDefinition = {
  name: 'storage',
  description: 'Manage browser localStorage and sessionStorage.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID',
      },
      storageType: {
        type: 'string',
        enum: ['local', 'session'],
        description: 'local or session storage',
      },
      action: {
        type: 'string',
        enum: ['get', 'set', 'remove', 'clear', 'keys'],
        description: 'Action to perform',
      },
      key: {
        type: 'string',
        description: 'Storage key',
      },
      value: {
        type: 'string',
        description: 'Value to store (string)',
      },
      dryRun: {
        type: 'boolean',
        description:
          'Preview-only mode for destructive actions (remove, clear). When true, returns counts and a sample of keys that would be deleted without mutating any state. Default: false.',
      },
    },
    required: ['tabId', 'storageType', 'action'],
  },
  annotations: TOOL_ANNOTATIONS.storage,
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const storageType = args.storageType as 'local' | 'session';
  const action = args.action as string;
  const key = args.key as string | undefined;
  const value = args.value as string | undefined;
  const dryRun = args.dryRun === true;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!storageType || !['local', 'session'].includes(storageType)) {
    return {
      content: [{ type: 'text', text: 'Error: storageType must be "local" or "session"' }],
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
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'storage');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Domain blocklist check
    assertDomainAllowed(page.url());

    const storageName = storageType === 'local' ? 'localStorage' : 'sessionStorage';

    switch (action) {
      case 'get': {
        if (key) {
          // Get specific key
          const result = await withTimeout(page.evaluate(
            (storage: string, k: string) => {
              const s = storage === 'localStorage' ? localStorage : sessionStorage;
              return s.getItem(k);
            },
            storageName,
            key
          ), 5000, 'storage');

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'get',
                  storageType,
                  key,
                  value: result,
                  exists: result !== null,
                }),
              },
            ],
          };
        } else {
          // Get all values
          const result = await withTimeout(page.evaluate((storage: string) => {
            const s = storage === 'localStorage' ? localStorage : sessionStorage;
            const items: Record<string, string | null> = {};
            for (let i = 0; i < s.length; i++) {
              const key = s.key(i);
              if (key) {
                items[key] = s.getItem(key);
              }
            }
            return items;
          }, storageName), 5000, 'storage');

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'get',
                  storageType,
                  items: result,
                  count: Object.keys(result).length,
                }),
              },
            ],
          };
        }
      }

      case 'set': {
        if (!key) {
          return {
            content: [{ type: 'text', text: 'Error: key is required for set action' }],
            isError: true,
          };
        }
        if (value === undefined) {
          return {
            content: [{ type: 'text', text: 'Error: value is required for set action' }],
            isError: true,
          };
        }

        await withTimeout(page.evaluate(
          (storage: string, k: string, v: string) => {
            const s = storage === 'localStorage' ? localStorage : sessionStorage;
            s.setItem(k, v);
          },
          storageName,
          key,
          value
        ), 5000, 'storage');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'set',
                storageType,
                key,
                value,
                message: `Set ${storageName}["${key}"] = "${value}"`,
              }),
            },
          ],
        };
      }

      case 'remove': {
        if (!key) {
          return {
            content: [{ type: 'text', text: 'Error: key is required for remove action' }],
            isError: true,
          };
        }

        await withTimeout(page.evaluate(
          (storage: string, k: string) => {
            const s = storage === 'localStorage' ? localStorage : sessionStorage;
            s.removeItem(k);
          },
          storageName,
          key
        ), 5000, 'storage');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'remove',
                storageType,
                key,
                message: `Removed "${key}" from ${storageName}`,
              }),
            },
          ],
        };
      }

      case 'clear': {
        // #878 — dryRun: report what would be cleared; no mutation.
        if (dryRun) {
          const preview = await withTimeout(
            page.evaluate((storage: string) => {
              const s = storage === 'localStorage' ? localStorage : sessionStorage;
              const sample: string[] = [];
              for (let i = 0; i < Math.min(s.length, 10); i++) {
                const k = s.key(i);
                if (k) sample.push(k);
              }
              return { count: s.length, sample };
            }, storageName),
            5000,
            'storage',
          );
          const wouldAffect = {
            count: preview.count,
            samples: preview.sample,
            details: { storageType, storageName },
          };
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'clear',
                  dryRun: true,
                  wouldAffect,
                  guidance: 'Pass dryRun:false (or omit) to execute.',
                }),
              },
            ],
            structuredContent: {
              dryRun: true,
              wouldAffect,
              guidance: 'Pass dryRun:false (or omit) to execute.',
            },
          };
        }

        const countBefore = await withTimeout(page.evaluate((storage: string) => {
          const s = storage === 'localStorage' ? localStorage : sessionStorage;
          return s.length;
        }, storageName), 5000, 'storage');

        await withTimeout(page.evaluate((storage: string) => {
          const s = storage === 'localStorage' ? localStorage : sessionStorage;
          s.clear();
        }, storageName), 5000, 'storage');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'clear',
                storageType,
                clearedCount: countBefore,
                message: `Cleared ${countBefore} items from ${storageName}`,
              }),
            },
          ],
        };
      }

      case 'keys': {
        const keys = await withTimeout(page.evaluate((storage: string) => {
          const s = storage === 'localStorage' ? localStorage : sessionStorage;
          const result: string[] = [];
          for (let i = 0; i < s.length; i++) {
            const key = s.key(i);
            if (key) {
              result.push(key);
            }
          }
          return result;
        }, storageName), 5000, 'storage');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'keys',
                storageType,
                keys,
                count: keys.length,
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
              text: `Error: Unknown action "${action}". Use: get, set, remove, clear, or keys`,
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
          text: `Storage error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerStorageTool(server: MCPServer): void {
  server.registerTool('storage', handler, definition);
}
