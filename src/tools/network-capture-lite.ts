/**
 * network_capture_lite — passive request/response observation (no bodies).
 *
 * Records URL, method, headers, status, timing, initiator for every request
 * fired by the page. Uses puppeteer's passive event surface only — never
 * activates `setRequestInterception(true)` and therefore never pauses the
 * request lifecycle, unlike `request_intercept`.
 *
 * For body-bearing captures use `network_capture_full`.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { createNetworkCaptureHandler, NETWORK_CAPTURE_INPUT_SCHEMA } from './network-capture-shared';

const definition: MCPToolDefinition = {
  name: 'network_capture_lite',
  description: 'Capture network request metadata + headers (no bodies). Cheap passive recorder. Actions: start, stop, getLogs, clear.',
  annotations: TOOL_ANNOTATIONS.network_capture_lite,
  inputSchema: NETWORK_CAPTURE_INPUT_SCHEMA,
};

const handler: ToolHandler = createNetworkCaptureHandler('lite');

export function registerNetworkCaptureLiteTool(server: MCPServer): void {
  server.registerTool('network_capture_lite', handler, definition);
}
