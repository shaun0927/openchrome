/**
 * Connection config generator — produces per-host connection info
 * from the current server state (tunnel URL, auth token).
 * Part of #523: Desktop App Web host connection guide.
 */

import type { WebAIHostId, ConnectionInfo, ServerConnectionState } from './types';
import { getHostDefinition } from './hosts';

/**
 * Generate connection info for a specific web AI host.
 */
export function generateConnectionInfo(
  hostId: WebAIHostId,
  state: ServerConnectionState,
): ConnectionInfo {
  const host = getHostDefinition(hostId);
  const tunnelActive = state.tunnelUrl !== null;
  const baseUrl = tunnelActive ? state.tunnelUrl! : state.localUrl;
  const serverUrl = baseUrl.replace(/\/+$/, '') + host.mcpPathSuffix;

  const configSnippet = buildConfigSnippet(serverUrl, state.authToken);

  return {
    host: hostId,
    hostName: host.name,
    serverUrl,
    bearerToken: state.authToken,
    settingsUrl: host.settingsUrl,
    steps: host.steps,
    configSnippet,
    tunnelActive,
  };
}

/**
 * Generate connection info for all hosts.
 */
export function generateAllConnectionInfo(
  state: ServerConnectionState,
): Record<WebAIHostId, ConnectionInfo> {
  return {
    claude: generateConnectionInfo('claude', state),
    chatgpt: generateConnectionInfo('chatgpt', state),
    gemini: generateConnectionInfo('gemini', state),
    custom: generateConnectionInfo('custom', state),
  };
}

/**
 * Build a JSON config snippet for manual configuration.
 */
function buildConfigSnippet(serverUrl: string, authToken: string | null): string {
  const config: Record<string, unknown> = { url: serverUrl };

  if (authToken) {
    config.headers = { Authorization: `Bearer ${authToken}` };
  }

  return JSON.stringify(config, null, 2);
}
