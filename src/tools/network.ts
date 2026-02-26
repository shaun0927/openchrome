/**
 * Network Tool - Network simulation and throttling
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

// Predefined network conditions
const NETWORK_PRESETS: Record<
  string,
  { downloadThroughput: number; uploadThroughput: number; latency: number }
> = {
  offline: {
    downloadThroughput: 0,
    uploadThroughput: 0,
    latency: 0,
  },
  'slow-2g': {
    downloadThroughput: (50 * 1024) / 8, // 50 Kbps
    uploadThroughput: (20 * 1024) / 8,
    latency: 2000,
  },
  '2g': {
    downloadThroughput: (250 * 1024) / 8, // 250 Kbps
    uploadThroughput: (50 * 1024) / 8,
    latency: 300,
  },
  '3g': {
    downloadThroughput: (1.5 * 1024 * 1024) / 8, // 1.5 Mbps
    uploadThroughput: (750 * 1024) / 8,
    latency: 100,
  },
  '4g': {
    downloadThroughput: (20 * 1024 * 1024) / 8, // 20 Mbps
    uploadThroughput: (10 * 1024 * 1024) / 8,
    latency: 20,
  },
  'fast-wifi': {
    downloadThroughput: (100 * 1024 * 1024) / 8, // 100 Mbps
    uploadThroughput: (50 * 1024 * 1024) / 8,
    latency: 2,
  },
};

const definition: MCPToolDefinition = {
  name: 'network',
  description: 'Simulate network conditions like throttling, latency, and offline mode. Use a preset or provide custom settings.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to apply network conditions to',
      },
      preset: {
        type: 'string',
        description:
          'Network preset: offline, slow-2g, 2g, 3g, 4g, fast-wifi, custom, or clear',
        enum: ['offline', 'slow-2g', '2g', '3g', '4g', 'fast-wifi', 'custom', 'clear'],
      },
      downloadKbps: {
        type: 'number',
        description: 'Custom download speed in Kbps (only for preset=custom)',
      },
      uploadKbps: {
        type: 'number',
        description: 'Custom upload speed in Kbps (only for preset=custom)',
      },
      latencyMs: {
        type: 'number',
        description: 'Custom latency in milliseconds (only for preset=custom)',
      },
    },
    required: ['tabId', 'preset'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const preset = args.preset as string;
  const downloadKbps = args.downloadKbps as number | undefined;
  const uploadKbps = args.uploadKbps as number | undefined;
  const latencyMs = args.latencyMs as number | undefined;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!preset) {
    return {
      content: [{ type: 'text', text: 'Error: preset is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'network');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Preset network conditions
    const presetConfig = NETWORK_PRESETS[preset];
    if (preset !== 'clear' && preset !== 'custom' && !presetConfig) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Unknown preset "${preset}". Available: ${Object.keys(NETWORK_PRESETS).join(', ')}`,
          },
        ],
        isError: true,
      };
    }

    // Custom network conditions validation
    if (preset === 'custom') {
      if (downloadKbps === undefined || uploadKbps === undefined || latencyMs === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: custom preset requires downloadKbps, uploadKbps, and latencyMs',
            },
          ],
          isError: true,
        };
      }
    }

    // Apply network conditions via CDP with 5s timeout
    await Promise.race([
      (async () => {
        const client = await page.createCDPSession();
        try {
          if (preset === 'clear') {
            await client.send('Network.emulateNetworkConditions', {
              offline: false,
              downloadThroughput: -1,
              uploadThroughput: -1,
              latency: 0,
            });
          } else if (preset === 'custom') {
            await client.send('Network.emulateNetworkConditions', {
              offline: false,
              downloadThroughput: (downloadKbps! * 1024) / 8,
              uploadThroughput: (uploadKbps! * 1024) / 8,
              latency: latencyMs!,
            });
          } else {
            await client.send('Network.emulateNetworkConditions', {
              offline: preset === 'offline',
              downloadThroughput: presetConfig.downloadThroughput,
              uploadThroughput: presetConfig.uploadThroughput,
              latency: presetConfig.latency,
            });
          }
        } finally {
          await client.detach().catch(() => {});
        }
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Network CDP operation timed out')), 5000)
      ),
    ]);

    if (preset === 'clear') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'network_clear',
              message: 'Network throttling cleared',
            }),
          },
        ],
      };
    }

    if (preset === 'custom') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'network_custom',
              downloadKbps,
              uploadKbps,
              latencyMs,
              message: `Custom network conditions applied: ${downloadKbps}Kbps down, ${uploadKbps}Kbps up, ${latencyMs}ms latency`,
            }),
          },
        ],
      };
    }

    const downloadMbps = ((presetConfig.downloadThroughput * 8) / 1024 / 1024).toFixed(2);
    const uploadMbps = ((presetConfig.uploadThroughput * 8) / 1024 / 1024).toFixed(2);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'network_throttle',
            preset,
            downloadMbps: Number(downloadMbps),
            uploadMbps: Number(uploadMbps),
            latencyMs: presetConfig.latency,
            message:
              preset === 'offline'
                ? 'Network set to offline mode'
                : `Network throttled to ${preset}: ${downloadMbps}Mbps down, ${uploadMbps}Mbps up, ${presetConfig.latency}ms latency`,
          }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Network error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerNetworkTool(server: MCPServer): void {
  server.registerTool('network', handler, definition);
}
