/**
 * oc_devtools_url — return the Chrome DevTools inspector URL for a target.
 * Part of #860: DevTools URL exposure.
 *
 * Target resolution order:
 *   1. targetId provided → look up directly; not_found if missing.
 *   2. workerId provided → use that worker's current (last) target.
 *   3. default → default session's default worker's current target.
 *   4. No current target → not_found.
 *
 * Off-switch: when OPENCHROME_EXPOSE_DEVTOOLS_URL=0, always returns {error:'disabled'}.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getChromePool } from '../chrome/pool';
import { fetchJsonList } from '../chrome/devtools-info';
import { getGlobalConfig } from '../config/global';

function isDevToolsExposureEnabled(): boolean {
  return process.env.OPENCHROME_EXPOSE_DEVTOOLS_URL !== '0';
}

const definition: MCPToolDefinition = {
  name: 'oc_devtools_url',
  description:
    'Get the Chrome DevTools inspector URL for the current worker\'s active page. ' +
    'Returns a URL you can paste into any local browser to attach live DevTools to the running page. ' +
    'Use targetId to select a specific open tab, or workerId to select a specific worker\'s current page.',
  inputSchema: {
    type: 'object',
    properties: {
      targetId: {
        type: 'string',
        description: 'Optional CDP target ID. When provided, returns the DevTools URL for that specific tab.',
      },
      workerId: {
        type: 'string',
        description: 'Optional worker ID. When provided (and targetId is omitted), returns the DevTools URL for that worker\'s current page.',
      },
    },
    required: [],
  },
};

type ResolvePortResult =
  | { port: number }
  | { error: 'not_found' }
  | { error: 'chrome_unreachable' };

/**
 * Resolve the Chrome port for a given CDP targetId.
 * Walks pool instances: for each, fetch /json/list and check if the target appears there.
 * Falls back to the default port when pool is empty.
 *
 * Returns:
 *   { port }               — target found on this port
 *   { error: 'not_found' } — Chrome responded but target is not in any instance
 *   { error: 'chrome_unreachable' } — all ports failed to respond
 */
async function resolvePortForTarget(targetId: string): Promise<ResolvePortResult> {
  const pool = getChromePool();
  const poolInstances = pool.getInstances();
  const ports: number[] =
    poolInstances.size > 0
      ? Array.from(poolInstances.values()).map((inst) => inst.port)
      : [getGlobalConfig().port];

  let anyReachable = false;
  for (const port of ports) {
    const pages = await fetchJsonList(port);
    if (pages === null) continue; // this port is unreachable
    anyReachable = true;
    if (pages.some((p) => p.id === targetId)) {
      return { port };
    }
  }
  return anyReachable ? { error: 'not_found' } : { error: 'chrome_unreachable' };
}

/**
 * Fetch the devtoolsFrontendUrl for a specific targetId from Chrome's /json/list.
 */
async function getDevToolsFrontendUrl(
  targetId: string,
  port: number,
): Promise<string | null> {
  const pages = await fetchJsonList(port);
  if (!pages) return null;
  const page = pages.find((p) => p.id === targetId);
  return page?.devtoolsFrontendUrl ?? null;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  // Off-switch
  if (!isDevToolsExposureEnabled()) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'disabled', message: 'DevTools URL exposure is disabled (OPENCHROME_EXPOSE_DEVTOOLS_URL=0).' }),
        },
      ],
    };
  }

  const targetIdArg = args.targetId as string | undefined;
  const workerIdArg = args.workerId as string | undefined;

  const sessionManager = getSessionManager();

  let resolvedTargetId: string | undefined;

  if (targetIdArg) {
    // Path 1: explicit targetId
    resolvedTargetId = targetIdArg;
  } else {
    // Path 2 or 3: resolve via worker
    const effectiveSessionId = sessionId || 'default';
    const session = sessionManager.getSession(effectiveSessionId);

    if (!session) {
      // Try to find any session that has the requested worker
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'not_found', message: `Session '${effectiveSessionId}' not found.` }),
          },
        ],
      };
    }

    const workerId = workerIdArg || session.defaultWorkerId;
    const worker = sessionManager.getWorker(effectiveSessionId, workerId);

    if (!worker) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'not_found', message: `Worker '${workerId}' not found in session '${effectiveSessionId}'.` }),
          },
        ],
      };
    }

    // Use the last (most recently added) target in this worker
    const targets = Array.from(worker.targets);
    if (targets.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'not_found', message: `Worker '${workerId}' has no active targets.` }),
          },
        ],
      };
    }
    resolvedTargetId = targets[targets.length - 1];
  }

  // Resolve the Chrome instance port for this target
  const portResult = await resolvePortForTarget(resolvedTargetId);
  if ('error' in portResult) {
    const message = portResult.error === 'chrome_unreachable'
      ? `Chrome is unreachable — could not query any debug port for target '${resolvedTargetId}'.`
      : `Target '${resolvedTargetId}' not found in any reachable Chrome instance.`;
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: portResult.error, message }) }],
    };
  }

  const url = await getDevToolsFrontendUrl(resolvedTargetId, portResult.port);
  if (!url) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'not_found',
            message: `Target '${resolvedTargetId}' not found in Chrome's /json/list on port ${portResult.port}.`,
          }),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ targetId: resolvedTargetId, url }),
      },
    ],
  };
};

export function registerOcDevToolsUrlTool(server: MCPServer): void {
  if (!isDevToolsExposureEnabled()) {
    // When off-switch is active, do NOT register the tool so tools/list SHA
    // matches the v1.11 baseline.
    return;
  }
  server.registerTool('oc_devtools_url', handler, definition);
}
