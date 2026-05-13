/**
 * Checkpoint Tool — saves/loads automation state for long-session continuity.
 * Enables AI agents to persist task progress across context compaction.
 * Part of #347 Phase 4: AI Agent Continuity.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { writeFileAtomicSafe, readFileSafe } from '../utils/atomic-file';
import { getSessionManager } from '../session-manager';
import { safeTitle } from '../utils/safe-title';
import { getActiveActionRecorder } from '../recording/action-recorder';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AutomationCheckpoint {
  version: 1;
  timestamp: number;
  taskDescription: string;
  completedSteps: string[];
  pendingSteps: string[];
  currentUrl: string | null;
  tabStates: Array<{ tabId: string; url: string; title: string }>;
  extractedData: Record<string, unknown>;
}

// ─── Constants ─────────────────────────────────────────────────────────────

export const CHECKPOINT_DIR = path.join(os.homedir(), '.openchrome', 'checkpoints');
export const CHECKPOINT_FILE = 'current-checkpoint.json';

// ─── Tool Definition ───────────────────────────────────────────────────────

const definition: MCPToolDefinition = {
  name: 'oc_checkpoint',
  description:
    'Save or load an automation checkpoint for long-running session continuity. ' +
    'Use "save" to persist current task state, "load" to restore after context compaction, ' +
    '"delete" to clean up.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['save', 'load', 'delete'],
        description: 'Action to perform',
      },
      taskDescription: {
        type: 'string',
        description: 'Description of the current automation task (required for save)',
      },
      completedSteps: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of completed steps (for save)',
      },
      pendingSteps: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of pending steps (for save)',
      },
      extractedData: {
        type: 'object',
        description: 'Intermediate results to persist (for save)',
      },
    },
    required: ['action'],
  },
  annotations: TOOL_ANNOTATIONS.oc_checkpoint,
};

// ─── Tab Collection ────────────────────────────────────────────────────────

async function collectTabStates(): Promise<Array<{ tabId: string; url: string; title: string }>> {
  const tabStates: Array<{ tabId: string; url: string; title: string }> = [];

  try {
    const sessionManager = getSessionManager();
    const allSessionInfos = sessionManager.getAllSessionInfos();

    for (const sessionInfo of allSessionInfos) {
      const sessionId = sessionInfo.id;

      for (const workerInfo of sessionInfo.workers) {
        const workerId = workerInfo.id;
        const targetIds = sessionManager.getWorkerTargetIds(sessionId, workerId);

        for (const targetId of targetIds) {
          let url = 'about:blank';
          let title = '';

          try {
            const page = await sessionManager.getPage(sessionId, targetId, workerId);
            if (page) {
              url = page.url() || 'about:blank';
              try {
                title = await safeTitle(page);
              } catch {
                title = '';
              }
            }
          } catch {
            // Page may be closed or crashed
          }

          tabStates.push({ tabId: targetId, url, title });
        }
      }
    }
  } catch (err) {
    // Session manager may not be initialized or Chrome not connected
    console.error(
      '[Checkpoint] collectTabStates error (graceful fallback):',
      err instanceof Error ? err.message : String(err),
    );
  }

  return tabStates;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function readCurrentCheckpoint(): Promise<AutomationCheckpoint | null> {
  const checkpointPath = path.join(CHECKPOINT_DIR, CHECKPOINT_FILE);
  const result = await readFileSafe<AutomationCheckpoint>(checkpointPath);
  return result.success && result.data ? result.data : null;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const checkpointPath = path.join(CHECKPOINT_DIR, CHECKPOINT_FILE);
  const action = args.action as string;

  if (action === 'save') {
    const tabStates = await collectTabStates();
    const currentUrl = tabStates.length > 0 ? tabStates[0].url : null;

    const checkpoint: AutomationCheckpoint = {
      version: 1,
      timestamp: Date.now(),
      taskDescription: (args.taskDescription as string) || '',
      completedSteps: (args.completedSteps as string[]) || [],
      pendingSteps: (args.pendingSteps as string[]) || [],
      currentUrl,
      tabStates,
      extractedData: (args.extractedData as Record<string, unknown>) || {},
    };

    // Ensure directory exists (writeFileAtomicSafe also does this, but explicit for clarity)
    await fs.promises.mkdir(CHECKPOINT_DIR, { recursive: true });
    await writeFileAtomicSafe(checkpointPath, checkpoint);

    try {
      await getActiveActionRecorder(sessionId)?.appendCheckpoint(checkpoint as unknown as Record<string, unknown>);
    } catch {
      // Best-effort trajectory linkage must never fail checkpoint save.
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              status: 'saved',
              timestamp: new Date(checkpoint.timestamp).toISOString(),
              completedSteps: checkpoint.completedSteps.length,
              pendingSteps: checkpoint.pendingSteps.length,
              tabs: tabStates.length,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (action === 'load') {
    const cp = await readCurrentCheckpoint();
    if (!cp) {
      return {
        content: [
          {
            type: 'text',
            text: 'No checkpoint found. Start fresh or save a checkpoint first.',
          },
        ],
      };
    }

    const ageMs = Date.now() - cp.timestamp;
    const ageHours = Math.round((ageMs / 3600000) * 10) / 10;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              status: 'loaded',
              savedAt: new Date(cp.timestamp).toISOString(),
              ageHours,
              taskDescription: cp.taskDescription,
              completedSteps: cp.completedSteps,
              pendingSteps: cp.pendingSteps,
              currentUrl: cp.currentUrl,
              tabStates: cp.tabStates,
              extractedData: cp.extractedData,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (action === 'delete') {
    try {
      await fs.promises.unlink(checkpointPath);
      return {
        content: [{ type: 'text', text: 'Checkpoint deleted.' }],
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return {
          content: [{ type: 'text', text: 'No checkpoint to delete.' }],
        };
      }
      throw error;
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: `Unknown action: ${action}. Use save, load, or delete.`,
      },
    ],
    isError: true,
  };
};

// ─── Registration ──────────────────────────────────────────────────────────

export function registerCheckpointTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
