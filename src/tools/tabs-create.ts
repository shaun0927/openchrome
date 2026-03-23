/**
 * Tabs Create Tool - Create a new tab in the session with a specific URL
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { safeTitle } from '../utils/safe-title';
import { assertDomainAllowed } from '../security/domain-guard';

const definition: MCPToolDefinition = {
  name: 'tabs_create',
  description: 'Create a new tab with URL.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to open in the new tab',
      },
      workerId: {
        type: 'string',
        description: 'Worker ID for parallel ops. Default: default',
      },
      profileDirectory: {
        type: 'string',
        description: 'Chrome profile directory name (e.g., "Profile 1"). Use list_profiles to see available profiles. Launches a separate Chrome instance for each profile. If omitted, uses the server default. Cannot be combined with workerId.',
      },
    },
    required: ['url'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const sessionManager = getSessionManager();
  const url = args.url as string;
  const profileDirectory = args.profileDirectory as string | undefined;
  if (args.workerId && profileDirectory) {
    return {
      content: [{ type: 'text', text: 'Error: workerId and profileDirectory cannot be used together. Use profileDirectory alone (a worker is auto-created per profile).' }],
      isError: true,
    };
  }
  const workerId = (args.workerId as string | undefined) || (profileDirectory ? `profile:${profileDirectory}` : undefined);

  // URL is required
  if (!url) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: url is required. Use navigate tool without tabId to create a new tab with a URL.',
        },
      ],
      isError: true,
    };
  }

  // Domain blocklist check before creating the tab
  try {
    assertDomainAllowed(url);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const { targetId, page, workerId: assignedWorkerId } = await sessionManager.createTarget(sessionId, url, workerId, profileDirectory);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              tabId: targetId,
              workerId: assignedWorkerId,
              url: page.url(),
              title: await safeTitle(page),
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
          text: `Error creating tab: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerTabsCreateTool(server: MCPServer): void {
  server.registerTool('tabs_create', handler, definition);
}
