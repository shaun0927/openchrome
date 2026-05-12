/**
 * network_capture_full — passive request/response observation with response
 * bodies up to `maxBodyBytes` (default 256 KB).
 *
 * Bodies ≤ 32 KB are inlined as base64; larger bodies are spilled to disk
 * under `~/.openchrome/network-bodies/<sessionId>/<requestId>`. Bodies
 * exceeding `maxBodyBytes` are recorded as `body.mode='omitted', reason='over_cap'`.
 *
 * Like `network_capture_lite`, this tool uses puppeteer's passive event
 * surface only and does NOT call `setRequestInterception(true)`.
 *
 * Lite and full cannot both be active on the same tab — starting one while
 * the other is active returns `{success:false, error:'already_capturing'}`.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, ToolHandler } from '../types/mcp';
import { createNetworkCaptureHandler, NETWORK_CAPTURE_INPUT_SCHEMA } from './network-capture-shared';

const definition: MCPToolDefinition = {
  name: 'network_capture_full',
  description: 'Capture network requests with response bodies (capped). Actions: start, stop, getLogs, clear. Bodies over maxBodyBytes are omitted with reason="over_cap".',
  inputSchema: NETWORK_CAPTURE_INPUT_SCHEMA,
};

const handler: ToolHandler = createNetworkCaptureHandler('full');

export function registerNetworkCaptureFullTool(server: MCPServer): void {
  server.registerTool('network_capture_full', handler, definition);
}
