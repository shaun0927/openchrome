/**
 * Connect tools — expose web AI host connection info via MCP protocol.
 * Part of #523: Desktop App Web host connection guide.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { generateConnectionInfo, generateAllConnectionInfo, getHostIds } from '../connect/index';
import { copyToClipboard } from '../connect/clipboard';
import { openInBrowser } from '../connect/open-url';
import type { WebAIHostId, ServerConnectionState } from '../connect/types';

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

const getConnectionInfoDef: MCPToolDefinition = {
  name: 'oc_get_connection_info',
  description:
    'Get connection configuration for a web AI host (Claude Web, ChatGPT, Gemini, or custom). Returns the MCP server URL, bearer token, settings page URL, and step-by-step instructions.',
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

  if (hostArg === 'all') {
    const all = generateAllConnectionInfo(state);
    return { content: [{ type: 'text', text: JSON.stringify(all, null, 2) }] };
  }

  const validHosts = getHostIds();
  if (!validHosts.includes(hostArg as WebAIHostId)) {
    return {
      content: [{ type: 'text', text: `Invalid host: ${hostArg}. Valid hosts: ${validHosts.join(', ')}` }],
      isError: true,
    };
  }

  const info = generateConnectionInfo(hostArg as WebAIHostId, state);
  return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
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
