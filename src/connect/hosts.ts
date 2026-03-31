/**
 * Web AI host definitions — static configuration for each supported platform.
 * Part of #523: Desktop App Web host connection guide.
 */

import type { HostDefinition, WebAIHostId } from './types';

export const HOST_DEFINITIONS: Record<WebAIHostId, HostDefinition> = {
  claude: {
    id: 'claude',
    name: 'Claude Web',
    mcpPathSuffix: '/mcp',
    settingsUrl: 'https://claude.ai/customize/connectors?modal=add-custom-connector',
    protocol: 'streamable-http',
    steps: [
      'Click "Open Claude Web Settings" below',
      'Paste the server URL into the URL field',
      'Click Save — you\'re ready to chat!',
    ],
    notes: [
      'OAuth fields can be left empty — authentication uses the Bearer token in the Authorization header.',
    ],
  },

  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    mcpPathSuffix: '/mcp',
    settingsUrl: 'https://chatgpt.com/gpts/mine',
    protocol: 'streamable-http',
    steps: [
      'Click "Open ChatGPT Settings" below',
      'Create or edit an app, then paste the server URL',
      'Save and start a conversation with your app',
    ],
    notes: [
      'ChatGPT uses Streamable HTTP / SSE for MCP connections.',
      'You may need to enable Developer Mode in ChatGPT settings.',
    ],
  },

  gemini: {
    id: 'gemini',
    name: 'Gemini',
    mcpPathSuffix: '/mcp',
    settingsUrl: 'https://aistudio.google.com/app/mcpserver',
    protocol: 'sse',
    steps: [
      'Click "Open Gemini Settings" below',
      'Add a custom MCP server and paste the server URL',
      'Complete any additional Google Cloud setup if prompted',
    ],
    notes: [
      'Gemini MCP support may require a Google Cloud project.',
      'Check Google AI Studio for the latest MCP integration steps.',
    ],
  },

  custom: {
    id: 'custom',
    name: 'Other / Custom',
    mcpPathSuffix: '/mcp',
    settingsUrl: null,
    protocol: 'streamable-http',
    steps: [
      'Copy the server URL and Bearer token below',
      'Paste into your MCP client\'s server configuration',
      'Start using OpenChrome tools in your client',
    ],
    notes: [
      'Works with Claude Desktop, Cursor, Windsurf, and any MCP-compatible client.',
      'For stdio clients, use: npx openchrome serve (no tunnel needed).',
    ],
  },
};

/**
 * Get a host definition by ID.
 */
export function getHostDefinition(hostId: WebAIHostId): HostDefinition {
  return HOST_DEFINITIONS[hostId];
}

/**
 * Get all supported host IDs.
 */
export function getHostIds(): WebAIHostId[] {
  return Object.keys(HOST_DEFINITIONS) as WebAIHostId[];
}
