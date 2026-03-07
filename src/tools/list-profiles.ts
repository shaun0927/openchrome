/**
 * List Profiles Tool - Discover available Chrome profiles
 *
 * Reads Chrome's Local State file to list all profiles with their
 * display names and directory names. Enables profile selection by
 * mapping user-friendly names to --profile-directory values.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { ProfileManager } from '../chrome/profile-manager';
import { getChromeLauncher } from '../chrome/launcher';

const definition: MCPToolDefinition = {
  name: 'list_profiles',
  description: 'List available Chrome profiles. Returns profile names and directory IDs for use with profileDirectory parameter.',
  inputSchema: {
    type: 'object',
    properties: {
      userDataDir: {
        type: 'string',
        description: 'Custom Chrome user data directory. Omit to use default Chrome location.',
      },
    },
    required: [],
  },
};

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  try {
    const profileManager = new ProfileManager();
    const userDataDir = args.userDataDir as string | undefined;
    const profiles = profileManager.listProfiles(userDataDir);

    if (profiles.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No Chrome profiles found. Chrome may not be installed or the user data directory is empty.',
          },
        ],
      };
    }

    // Get current active profile from launcher state
    const launcher = getChromeLauncher();
    const currentState = launcher.getProfileState();
    const currentProfileDirectory = currentState.profileDirectory;

    const lines: string[] = [
      `Found ${profiles.length} Chrome profile(s):`,
      '',
    ];

    for (const profile of profiles) {
      const marker = profile.isActive ? ' (last used)' : '';
      const currentMarker = currentProfileDirectory === profile.directory ? ' [CURRENT]' : '';
      lines.push(`  ${profile.directory}: "${profile.name}"${profile.userName ? ` (${profile.userName})` : ''}${marker}${currentMarker}`);
    }

    lines.push('');
    lines.push('To use a specific profile, restart the server with --profile-directory "<directory>" (e.g., --profile-directory "Profile 1").');

    return {
      content: [
        { type: 'text', text: JSON.stringify({ profiles, currentProfileDirectory: currentProfileDirectory || 'Default' }, null, 2) },
        { type: 'text', text: lines.join('\n') },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error listing profiles: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerListProfilesTool(server: MCPServer): void {
  server.registerTool('list_profiles', handler, definition);
}
