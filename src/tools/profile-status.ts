/**
 * Profile Status Tool - Check browser profile type and capabilities
 *
 * Provides visibility into whether OpenChrome is running with the user's
 * real Chrome profile, a persistent OpenChrome profile, or a temporary profile,
 * and what capabilities are available in each mode.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getChromeLauncher } from '../chrome/launcher';

const definition: MCPToolDefinition = {
  name: 'oc_profile_status',
  description:
    'Check the current browser profile type and capabilities. ' +
    'Returns whether the browser is using the real Chrome profile (full capability), ' +
    'a persistent OpenChrome profile (synced cookies, persistent storage), ' +
    'or a temporary profile (no user data). ' +
    'Use this to diagnose authentication failures or missing browser features.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const handler: ToolHandler = async (
  _sessionId: string,
  _args: Record<string, unknown>
): Promise<MCPResult> => {
  try {
    const launcher = getChromeLauncher();
    const profileType = launcher.getProfileType();

    const capabilities = {
      extensions: profileType === 'real',
      savedPasswords: profileType === 'real',
      localStorage: profileType === 'real' || profileType === 'persistent',
      bookmarks: profileType === 'real',
      formAutofill: profileType === 'real',
      sessionCookies: profileType === 'real' || profileType === 'persistent',
      persistentStorage: profileType === 'real' || profileType === 'persistent',
    };

    const result: Record<string, unknown> = {
      profileType: profileType ?? 'unknown',
      capabilities,
    };

    const lines: string[] = [];
    if (profileType === 'real') {
      lines.push('Profile: Real Chrome profile (full capability)');
      lines.push('All browser features available: extensions, saved passwords, localStorage, bookmarks, form autofill.');
    } else if (profileType === 'persistent') {
      lines.push('Profile: Persistent OpenChrome profile (synced cookies from real profile)');
      lines.push('Available: synced cookies, localStorage, IndexedDB, service workers (persist across sessions)');
      lines.push('Not available: extensions, saved passwords, bookmarks, form autofill');
      lines.push('');
      lines.push('Tip: Cookies are synced from the real profile. If authentication fails, a fresh sync will happen on next launch.');
    } else if (profileType === 'temp') {
      lines.push('Profile: Fresh temporary profile (no user data)');
      lines.push('Not available: cookies, extensions, saved passwords, localStorage, bookmarks, form autofill');
      lines.push('');
      lines.push('Tip: The user will need to log in manually to any sites that require authentication.');
    } else if (profileType === 'explicit') {
      lines.push('Profile: User-specified custom profile directory');
      lines.push('Capabilities depend on the profile contents.');
    } else {
      lines.push('Profile: Unknown (Chrome may not be launched yet)');
    }

    return {
      content: [
        { type: 'text', text: JSON.stringify(result, null, 2) },
        { type: 'text', text: lines.join('\n') },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error checking profile status: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerProfileStatusTool(server: MCPServer): void {
  server.registerTool('oc_profile_status', handler, definition);
}
