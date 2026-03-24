/**
 * Connection Health Tool — exposes CDP connection metrics for AI agent monitoring.
 * Part of #347 Phase 3C: Connection Health Metrics.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getCDPClient } from '../cdp/client';

const definition: MCPToolDefinition = {
  name: 'oc_connection_health',
  description:
    'Get CDP connection health metrics including heartbeat mode, reconnect count, ping latency, connection state, and live reconnection progress. Use this to monitor connection stability during long-running sessions.',
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
    const cdpClient = getCDPClient();
    const metrics = cdpClient.getConnectionMetrics();
    const state = cdpClient.getConnectionState();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              connectionState: state,
              heartbeatMode: metrics.heartbeatMode,
              reconnectCount: metrics.reconnectCount,
              avgPingLatencyMs: metrics.avgPingLatencyMs,
              msSinceLastVerified: metrics.msSinceLastVerified,
              consecutiveSuccesses: metrics.consecutiveSuccesses,
              lastVerifiedAt:
                metrics.lastVerifiedAt > 0
                  ? new Date(metrics.lastVerifiedAt).toISOString()
                  : null,
              reconnecting: metrics.reconnecting,
              reconnectAttempt: metrics.reconnectAttempt,
              reconnectNextRetryInMs: metrics.reconnectNextRetryInMs,
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
          text: `Connection health unavailable: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerConnectionHealthTool(server: MCPServer): void {
  server.registerTool('oc_connection_health', handler, definition);
}
