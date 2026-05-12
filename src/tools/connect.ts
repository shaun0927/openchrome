/**
 * Connect tools — expose web AI host connection info via MCP protocol.
 * Part of #523: Desktop App Web host connection guide.
 * Part of #860: DevTools URL exposure via devtools field + oc_devtools_url tool.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { generateConnectionInfo, generateAllConnectionInfo, getHostIds } from '../connect/index';
import { copyToClipboard } from '../connect/clipboard';
import { openInBrowser } from '../connect/open-url';
import type { WebAIHostId, ServerConnectionState } from '../connect/types';
import { getChromePool } from '../chrome/pool';
import { getDevToolsInstanceInfo } from '../chrome/devtools-info';
import { getGlobalConfig } from '../config/global';

function getServerState(): ServerConnectionState {
  const httpPort = process.env.OPENCHROME_HTTP_PORT || '3100';
  const httpHost = process.env.OPENCHROME_HTTP_HOST || '127.0.0.1';
  const bindAddr = httpHost === '0.0.0.0' ? '127.0.0.1' : httpHost;

  return {
    tunnelUrl: process.env.OPENCHROME_TUNNEL_URL || null,
    localUrl: `http://${bindAddr}:${httpPort}`,
    authToken: process.env.OPENCHROME_AUTH_TOKEN || null,
  };
}

/**
 * Returns true when DevTools URL exposure is enabled (default: on).
 * Gated by OPENCHROME_EXPOSE_DEVTOOLS_URL !== '0'.
 */
export function isDevToolsExposureEnabled(): boolean {
  return process.env.OPENCHROME_EXPOSE_DEVTOOLS_URL !== '0';
}

/**
 * Collect DevTools instance info from all active Chrome pool instances.
 * Also queries the default single-instance port when the pool has no entries.
 * Returns undefined if unreachable or exposure is disabled.
 */
export async function collectDevToolsInfo(): Promise<
  { instances: Awaited<ReturnType<typeof getDevToolsInstanceInfo>>[] } | undefined
> {
  if (!isDevToolsExposureEnabled()) {
    return undefined;
  }

  // Collect ports: prefer pool instances; fall back to default port
  const pool = getChromePool();
  const poolInstances = pool.getInstances();
  const ports: number[] =
    poolInstances.size > 0
      ? Array.from(poolInstances.values()).map((inst) => inst.port)
      : [getGlobalConfig().port];

  const results = await Promise.all(ports.map((p) => getDevToolsInstanceInfo(p)));
  const reachable = results.filter((r) => r !== null) as NonNullable<typeof results[number]>[];

  if (reachable.length === 0) {
    return undefined;
  }

  return { instances: reachable };
}

const getConnectionInfoDef: MCPToolDefinition = {
  name: 'oc_get_connection_info',
  description:
    'Get connection configuration for a web AI host (Claude Web, ChatGPT, Gemini, or custom). Returns the MCP server URL, bearer token, settings page URL, step-by-step instructions, and (when Chrome is reachable) a devtools block with live DevTools inspector URLs for all open pages.',
  inputSchema: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        enum: ['claude', 'chatgpt', 'gemini', 'custom', 'all'],
        description: 'Web AI host to generate config for. Use "all" for all hosts.',
      },
    },
    required: ['host'],
  },
};

const getConnectionInfoHandler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const hostArg = args.host as string;
  const state = getServerState();

  // Fetch devtools info in parallel with host-info generation
  const devToolsPromise = collectDevToolsInfo();

  if (hostArg === 'all') {
    const [all, devtools] = await Promise.all([
      Promise.resolve(generateAllConnectionInfo(state)),
      devToolsPromise,
    ]);
    const response = devtools ? { ...all, devtools } : all;
    return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
  }

  const validHosts = getHostIds();
  if (!validHosts.includes(hostArg as WebAIHostId)) {
    return {
      content: [{ type: 'text', text: `Invalid host: ${hostArg}. Valid hosts: ${validHosts.join(', ')}` }],
      isError: true,
    };
  }

  const [info, devtools] = await Promise.all([
    Promise.resolve(generateConnectionInfo(hostArg as WebAIHostId, state)),
    devToolsPromise,
  ]);
  const response = devtools ? { ...info, devtools } : info;
  return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
};

const copyToClipboardDef: MCPToolDefinition = {
  name: 'oc_copy_to_clipboard',
  description: 'Copy text to the system clipboard. Useful for copying MCP server URLs or config snippets.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to copy to clipboard.' },
    },
    required: ['text'],
  },
};

const copyToClipboardHandler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const text = args.text as string;
  try {
    await copyToClipboard(text);
    return { content: [{ type: 'text', text: 'Copied to clipboard.' }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Clipboard copy failed: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};

const openHostSettingsDef: MCPToolDefinition = {
  name: 'oc_open_host_settings',
  description: 'Open the MCP connector settings page for a web AI host in the default browser.',
  inputSchema: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        enum: ['claude', 'chatgpt', 'gemini'],
        description: 'Web AI host whose settings page to open.',
      },
    },
    required: ['host'],
  },
};

const openHostSettingsHandler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const hostArg = args.host as string;
  const validHosts = getHostIds();
  if (!validHosts.includes(hostArg as WebAIHostId)) {
    return {
      content: [{ type: 'text', text: `Invalid host: ${hostArg}. Valid hosts: ${validHosts.join(', ')}` }],
      isError: true,
    };
  }

  const state = getServerState();
  const info = generateConnectionInfo(hostArg as WebAIHostId, state);

  if (!info.settingsUrl) {
    return {
      content: [{ type: 'text', text: `No settings page available for ${info.hostName}.` }],
      isError: true,
    };
  }

  try {
    await openInBrowser(info.settingsUrl);
    return { content: [{ type: 'text', text: `Opened ${info.hostName} settings: ${info.settingsUrl}` }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to open browser: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};

export function registerConnectTools(server: MCPServer): void {
  server.registerTool('oc_get_connection_info', getConnectionInfoHandler, getConnectionInfoDef);
  server.registerTool('oc_copy_to_clipboard', copyToClipboardHandler, copyToClipboardDef);
  server.registerTool('oc_open_host_settings', openHostSettingsHandler, openHostSettingsDef);
}
