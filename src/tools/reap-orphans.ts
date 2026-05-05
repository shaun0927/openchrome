import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { cleanOrphanedChromeProcesses } from '../utils/pid-manager';

const definition: MCPToolDefinition = {
  name: 'oc_reap_orphans',
  description: 'Manually sweep and terminate orphaned OpenChrome-managed Chrome processes. Never touches attach-mode or unmarked user Chrome.',
  inputSchema: {
    type: 'object',
    properties: {
      ports: {
        type: 'array',
        items: { type: 'number' },
        description: 'Optional Chrome remote-debugging ports to check for legacy PID-file orphans. Defaults to 9222-9226; ownership markers are always scanned.',
      },
    },
    required: [],
  },
};

const DEFAULT_PORTS = [9222, 9223, 9224, 9225, 9226];

function normalizePorts(value: unknown): number[] {
  if (!Array.isArray(value)) return DEFAULT_PORTS;
  const ports = value
    .map((item) => typeof item === 'number' ? item : Number(item))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  return ports.length > 0 ? Array.from(new Set(ports)) : DEFAULT_PORTS;
}

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const ports = normalizePorts(args.ports);
  const killed = cleanOrphanedChromeProcesses(ports);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        action: 'oc_reap_orphans',
        killed,
        checkedPorts: ports,
        markerScan: true,
        message: killed === 0
          ? 'No orphaned OpenChrome-managed Chrome processes found.'
          : `Terminated ${killed} orphaned OpenChrome-managed Chrome process(es).`,
      }),
    }],
  };
};

export function registerReapOrphansTool(server: MCPServer): void {
  server.registerTool('oc_reap_orphans', handler, definition);
}
