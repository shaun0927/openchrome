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
import { formatAge } from '../utils/format-age';

const definition: MCPToolDefinition = {
  name: 'oc_profile_status',
  description: 'Check browser profile type (real/persistent/temporary) and capabilities. Use to diagnose auth failures.',
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
    const state = launcher.getProfileState();

    const capabilities = {
      extensions: state.extensionsAvailable,
      savedPasswords: state.type === 'real',
      localStorage: state.type === 'real' || state.type === 'persistent',
      bookmarks: state.type === 'real',
      formAutofill: state.type === 'real',
      sessionCookies: state.type === 'real' || state.type === 'persistent',
      persistentStorage: state.type === 'real' || state.type === 'persistent',
    };

    const result: Record<string, unknown> = {
      profileType: state.type,
      capabilities,
      ...(state.sourceProfile && {
        realProfileLocked: true,
      }),
      ...(state.cookieCopiedAt && {
        cookiesCopied: true,
        cookieAge: Date.now() - state.cookieCopiedAt,
        cookieAgeFormatted: formatAge(state.cookieCopiedAt),
      }),
    };

    const lines: string[] = [];
    if (state.type === 'real') {
      lines.push('Profile: Real Chrome profile (full capability)');
      lines.push('All browser features available: extensions, saved passwords, localStorage, bookmarks, form autofill.');
    } else if (state.type === 'persistent') {
      lines.push('Profile: Persistent OpenChrome profile (synced cookies from real profile)');
      if (state.cookieCopiedAt) {
        lines.push(`Cookie sync age: ${formatAge(state.cookieCopiedAt)}`);
      }
      lines.push('Available: synced cookies, localStorage, IndexedDB, service workers (persist across sessions)');
      lines.push('Not available: extensions, saved passwords, bookmarks, form autofill');
      lines.push('');
      lines.push('Tip: Cookies are synced from the real profile. If authentication fails, a fresh sync will happen on next launch.');
    } else if (state.type === 'temp') {
      lines.push('Profile: Fresh temporary profile (no user data)');
      lines.push('Not available: cookies, extensions, saved passwords, localStorage, bookmarks, form autofill');
      lines.push('');
      lines.push('Tip: The user will need to log in manually to any sites that require authentication.');
    } else if (state.type === 'explicit') {
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
