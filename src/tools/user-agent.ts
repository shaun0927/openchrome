/**
 * User-Agent Tool - Change browser user agent
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

// Predefined user agent strings
const USER_AGENT_PRESETS: Record<string, string> = {
  'chrome-windows':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'chrome-mac':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'firefox-windows':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'firefox-mac':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
  'safari-mac':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'safari-iphone':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'safari-ipad':
    'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'chrome-android':
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  googlebot:
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bingbot:
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
};

const definition: MCPToolDefinition = {
  name: 'user_agent',
  description: `Change the browser's User-Agent string.
Presets: ${Object.keys(USER_AGENT_PRESETS).join(', ')}
Use "preset" for predefined user agents or "custom" for a custom string.`,
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to change user agent for',
      },
      preset: {
        type: 'string',
        description: `Preset name: ${Object.keys(USER_AGENT_PRESETS).join(', ')}`,
        enum: Object.keys(USER_AGENT_PRESETS),
      },
      custom: {
        type: 'string',
        description: 'Custom user agent string (overrides preset if provided)',
      },
    },
    required: ['tabId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const preset = args.preset as string | undefined;
  const custom = args.custom as string | undefined;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!preset && !custom) {
    return {
      content: [
        { type: 'text', text: 'Error: Either preset or custom user agent is required' },
      ],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'user_agent');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    let userAgent: string;

    if (custom) {
      userAgent = custom;
    } else if (preset) {
      const presetUA = USER_AGENT_PRESETS[preset];
      if (!presetUA) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown preset "${preset}". Available: ${Object.keys(USER_AGENT_PRESETS).join(', ')}`,
            },
          ],
          isError: true,
        };
      }
      userAgent = presetUA;
    } else {
      return {
        content: [{ type: 'text', text: 'Error: No user agent specified' }],
        isError: true,
      };
    }

    await page.setUserAgent(userAgent);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'user_agent',
            preset: custom ? null : preset,
            userAgent,
            message: `User-Agent changed to: ${userAgent.slice(0, 80)}...`,
          }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `User-Agent error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerUserAgentTool(server: MCPServer): void {
  server.registerTool('user_agent', handler, definition);
}
