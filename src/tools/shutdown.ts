/**
 * Shutdown Tool - Gracefully stop OpenChrome and close Chrome
 *
 * Provides "oc stop" functionality:
 * 1. Clean up all sessions and workers
 * 2. Shutdown connection pool (close all pooled pages)
 * 3. Disconnect CDP client
 * 4. Kill Chrome process if OpenChrome launched it
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getCDPConnectionPool } from '../cdp/connection-pool';
import { getCDPClient } from '../cdp/client';
import { getChromeLauncher } from '../chrome/launcher';

const definition: MCPToolDefinition = {
  name: 'oc_stop',
  description: 'Shut down OpenChrome and close Chrome. Auto-relaunched on next tool call.',
  inputSchema: {
    type: 'object',
    properties: {
      keepChrome: {
        type: 'boolean',
        description: 'Keep Chrome running, just disconnect. Default: false',
      },
    },
    required: [],
  },
};

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const keepChrome = (args.keepChrome as boolean) || false;
  const steps: string[] = [];
  const startTime = Date.now();

  try {
    // Step 1: Clean up all sessions (closes workers, tabs, browser contexts)
    // Wrapped in its own try/catch so a broken CDP connection doesn't prevent
    // the remaining steps (pool shutdown, CDP disconnect, Chrome kill) from running.
    try {
      const sessionManager = getSessionManager();
      const sessionCount = await sessionManager.cleanupAllSessions();
      steps.push(`Cleaned up ${sessionCount} session(s)`);
    } catch (e) {
      steps.push(`Session cleanup failed: ${e instanceof Error ? e.message : 'error'} (skipped, continuing)`);
    }

    // Step 2: Shutdown connection pool (closes all pooled about:blank pages)
    try {
      const pool = getCDPConnectionPool();
      const stats = pool.getStats();
      await pool.shutdown();
      steps.push(`Shutdown connection pool (${stats.availablePages} pooled + ${stats.inUsePages} in-use pages closed)`);
    } catch (e) {
      steps.push(`Connection pool: ${e instanceof Error ? e.message : 'already shutdown'}`);
    }

    // Step 3: Disconnect CDP client
    try {
      const cdpClient = getCDPClient();
      if (cdpClient.isConnected()) {
        await cdpClient.disconnect();
        steps.push('Disconnected CDP client');
      } else {
        steps.push('CDP client: already disconnected');
      }
    } catch (e) {
      steps.push(`CDP client: ${e instanceof Error ? e.message : 'error'}`);
    }

    // Step 4: Close Chrome process (if OpenChrome launched it and keepChrome is false)
    if (!keepChrome) {
      try {
        const launcher = getChromeLauncher();
        if (launcher.isConnected()) {
          await launcher.close();
          steps.push('Chrome process terminated');
        } else {
          steps.push('Chrome: no OpenChrome-managed process to terminate');
        }
      } catch (e) {
        steps.push(`Chrome: ${e instanceof Error ? e.message : 'error'}`);
      }
    } else {
      steps.push('Chrome: kept running (keepChrome=true)');
    }

    const durationMs = Date.now() - startTime;

    return {
      content: [
        {
          type: 'text',
          text: [
            'OpenChrome stopped successfully.',
            '',
            'Shutdown steps:',
            ...steps.map((s, i) => `  ${i + 1}. ${s}`),
            '',
            `Total: ${durationMs}ms`,
            '',
            'Chrome will re-launch automatically on the next OpenChrome tool call.',
          ].join('\n'),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error during shutdown: ${error instanceof Error ? error.message : String(error)}\n\nPartial steps completed:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerShutdownTool(server: MCPServer): void {
  server.registerTool('oc_stop', handler, definition);
}
