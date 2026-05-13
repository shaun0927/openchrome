import { getGlobalConfig } from '../config/global';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
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
        description: 'Optional Chrome remote-debugging ports to check for legacy PID-file orphans. Defaults to the active CDP port window (base port through base+4); ownership markers are always scanned.',
      },
    },
    required: [],
  },
  annotations: TOOL_ANNOTATIONS.oc_reap_orphans,
};

const FALLBACK_BASE_PORT = 9222;
const PORT_WINDOW_SIZE = 5;

function parsePort(value: unknown): number | undefined {
  const port = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function defaultPorts(): number[] {
  const basePort = parsePort(getGlobalConfig().port) ?? FALLBACK_BASE_PORT;

  return Array.from({ length: PORT_WINDOW_SIZE }, (_, index) => basePort + index)
    .filter((port) => port <= 65535);
}

function normalizePorts(value: unknown): number[] {
  const fallbackPorts = defaultPorts();
  if (!Array.isArray(value)) return fallbackPorts;
  const ports = value
    .map((item) => parsePort(item))
    .filter((port): port is number => port !== undefined);
  return ports.length > 0 ? Array.from(new Set(ports)) : fallbackPorts;
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
