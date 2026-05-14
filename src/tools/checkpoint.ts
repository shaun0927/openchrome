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
  checkpointId?: string;
  parentId?: string;
  createdAt?: number;
  sessionId?: string;
  label?: string;
  taskDescription: string;
  completedSteps: string[];
  pendingSteps: string[];
  currentUrl: string | null;
  tabStates: Array<{ tabId: string; url: string; title: string; health?: 'unknown' }>;
  journalRange?: { fromTs: number; toTs: number };
  extractedData: Record<string, unknown>;
}

export interface CheckpointListEntry {
  checkpointId: string;
  parentId?: string;
  createdAt: number;
  savedAt: string;
  ageMs: number;
  sessionId?: string;
  label?: string;
  currentUrl: string | null;
  pendingSteps: number;
  completedSteps: number;
  tabs: number;
  journalRange?: { fromTs: number; toTs: number };
}

// ─── Constants ─────────────────────────────────────────────────────────────

export const CHECKPOINT_DIR = path.join(os.homedir(), '.openchrome', 'checkpoints');
export const CHECKPOINT_FILE = 'current-checkpoint.json';
const TIMELINE_DIR = 'timeline';
const DEFAULT_MAX_TIMELINE_CHECKPOINTS = 10;

// ─── Tool Definition ───────────────────────────────────────────────────────

const definition: MCPToolDefinition = {
  name: 'oc_checkpoint',
  description:
    'Save, load, list, or delete automation checkpoints for long-running session continuity. ' +
    'Use "save" to persist current task state, "list" to inspect the bounded checkpoint timeline, ' +
    '"load" to restore metadata after context compaction, and "delete" to clean up.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['save', 'load', 'list', 'delete'],
        description: 'Action to perform',
      },
      checkpointId: {
        type: 'string',
        description: 'Specific checkpoint id for load/delete. Omit to use latest/current checkpoint.',
      },
      label: {
        type: 'string',
        description: 'Optional short label for timeline inspection (save only).',
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

// ─── Persistence Helpers ───────────────────────────────────────────────────

export function getCheckpointDir(): string {
  return process.env.OPENCHROME_CHECKPOINT_DIR || CHECKPOINT_DIR;
}

function getCurrentCheckpointPath(): string {
  return path.join(getCheckpointDir(), CHECKPOINT_FILE);
}

function getTimelineDir(): string {
  return path.join(getCheckpointDir(), TIMELINE_DIR);
}

function sanitizeCheckpointId(id: string): string | null {
  if (!/^cp_[a-z0-9]+_[a-z0-9]+$/i.test(id)) return null;
  return id;
}

function generateCheckpointId(timestamp: number): string {
  return `cp_${timestamp.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function timelinePathFor(checkpointId: string): string {
  return path.join(getTimelineDir(), `${checkpointId}.json`);
}

function parseRetentionLimit(): number {
  const raw = Number(process.env.OPENCHROME_CHECKPOINT_TIMELINE_MAX || DEFAULT_MAX_TIMELINE_CHECKPOINTS);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_TIMELINE_CHECKPOINTS;
  return Math.min(Math.max(Math.floor(raw), 1), 100);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidCheckpointTimestamp(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (value < 0 || Math.abs(value) > 8.64e15) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function isTabStateArray(value: unknown): value is AutomationCheckpoint['tabStates'] {
  return Array.isArray(value) && value.every((tab) => (
    tab &&
    typeof tab === 'object' &&
    typeof (tab as Record<string, unknown>).tabId === 'string' &&
    typeof (tab as Record<string, unknown>).url === 'string' &&
    typeof (tab as Record<string, unknown>).title === 'string'
  ));
}

function isAutomationCheckpoint(value: unknown): value is AutomationCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const cp = value as Record<string, unknown>;
  return cp.version === 1 &&
    isValidCheckpointTimestamp(cp.timestamp) &&
    (cp.createdAt === undefined || isValidCheckpointTimestamp(cp.createdAt)) &&
    typeof cp.taskDescription === 'string' &&
    isStringArray(cp.completedSteps) &&
    isStringArray(cp.pendingSteps) &&
    (typeof cp.currentUrl === 'string' || cp.currentUrl === null) &&
    isTabStateArray(cp.tabStates) &&
    Boolean(cp.extractedData) &&
    typeof cp.extractedData === 'object' &&
    (cp.checkpointId === undefined || typeof cp.checkpointId === 'string');
}

function toListEntry(cp: AutomationCheckpoint, now = Date.now()): CheckpointListEntry | null {
  if (!isAutomationCheckpoint(cp) || !cp.checkpointId) return null;
  const createdAt = cp.createdAt ?? cp.timestamp;
  if (!isValidCheckpointTimestamp(createdAt)) return null;
  return {
    checkpointId: cp.checkpointId,
    ...(cp.parentId ? { parentId: cp.parentId } : {}),
    createdAt,
    savedAt: new Date(createdAt).toISOString(),
    ageMs: Math.max(0, now - createdAt),
    ...(cp.sessionId ? { sessionId: cp.sessionId } : {}),
    ...(cp.label ? { label: cp.label } : {}),
    currentUrl: cp.currentUrl,
    pendingSteps: cp.pendingSteps.length,
    completedSteps: cp.completedSteps.length,
    tabs: cp.tabStates.length,
    ...(cp.journalRange ? { journalRange: cp.journalRange } : {}),
  };
}

async function readTimelineCheckpoint(filePath: string): Promise<{ checkpoint: AutomationCheckpoint | null; warning?: string }> {
  const result = await readFileSafe<unknown>(filePath);
  if (!result.success || !result.data) {
    return { checkpoint: null, warning: `Skipped corrupt checkpoint timeline entry: ${path.basename(filePath)}` };
  }
  if (!isAutomationCheckpoint(result.data) || !result.data.checkpointId) {
    return { checkpoint: null, warning: `Skipped invalid checkpoint timeline entry: ${path.basename(filePath)}` };
  }
  return { checkpoint: result.data };
}

async function readTimelineEntries(): Promise<{ checkpoints: AutomationCheckpoint[]; warnings: string[] }> {
  const dir = getTimelineDir();
  const warnings: string[] = [];
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { checkpoints: [], warnings };
    throw err;
  }

  const checkpoints: AutomationCheckpoint[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const { checkpoint, warning } = await readTimelineCheckpoint(path.join(dir, name));
    if (warning) warnings.push(warning);
    if (checkpoint?.checkpointId) checkpoints.push(checkpoint);
  }
  checkpoints.sort((a, b) => {
    const timeDiff = (b.createdAt ?? b.timestamp) - (a.createdAt ?? a.timestamp);
    if (timeDiff !== 0) return timeDiff;
    return (b.checkpointId ?? '').localeCompare(a.checkpointId ?? '');
  });
  return { checkpoints, warnings };
}

async function pruneTimeline(): Promise<void> {
  const limit = parseRetentionLimit();
  const { checkpoints } = await readTimelineEntries();
  for (const cp of checkpoints.slice(limit)) {
    if (!cp.checkpointId) continue;
    const safeId = sanitizeCheckpointId(cp.checkpointId);
    if (!safeId) continue;
    await fs.promises.unlink(timelinePathFor(safeId)).catch(() => undefined);
  }
}

async function writeCheckpointTimeline(checkpoint: AutomationCheckpoint): Promise<void> {
  const safeId = checkpoint.checkpointId ? sanitizeCheckpointId(checkpoint.checkpointId) : null;
  if (!safeId) return;
  await fs.promises.mkdir(getTimelineDir(), { recursive: true });
  await writeFileAtomicSafe(timelinePathFor(safeId), checkpoint);
  await pruneTimeline();
}

// ─── Tab Collection ────────────────────────────────────────────────────────

async function collectTabStates(): Promise<Array<{ tabId: string; url: string; title: string; health: 'unknown' }>> {
  const tabStates: Array<{ tabId: string; url: string; title: string; health: 'unknown' }> = [];

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

          tabStates.push({ tabId: targetId, url, title, health: 'unknown' });
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
  const result = await readFileSafe<unknown>(getCurrentCheckpointPath());
  return result.success && isAutomationCheckpoint(result.data) ? result.data : null;
}

export async function readCheckpointById(checkpointId: string): Promise<AutomationCheckpoint | null> {
  const safeId = sanitizeCheckpointId(checkpointId);
  if (!safeId) return null;
  const result = await readFileSafe<unknown>(timelinePathFor(safeId));
  if (!result.success || !isAutomationCheckpoint(result.data)) return null;
  return result.data.checkpointId === safeId ? result.data : null;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const action = args.action as string;

  if (action === 'save') {
    if (args.completedSteps !== undefined && !isStringArray(args.completedSteps)) {
      return { content: [{ type: 'text', text: 'completedSteps must be an array of strings.' }], isError: true };
    }
    if (args.pendingSteps !== undefined && !isStringArray(args.pendingSteps)) {
      return { content: [{ type: 'text', text: 'pendingSteps must be an array of strings.' }], isError: true };
    }
    if (args.extractedData !== undefined && (!args.extractedData || typeof args.extractedData !== 'object' || Array.isArray(args.extractedData))) {
      return { content: [{ type: 'text', text: 'extractedData must be an object.' }], isError: true };
    }
    const completedSteps = args.completedSteps === undefined ? [] : args.completedSteps;
    const pendingSteps = args.pendingSteps === undefined ? [] : args.pendingSteps;
    const extractedData = (args.extractedData as Record<string, unknown> | undefined) ?? {};
    const tabStates = await collectTabStates();
    const currentUrl = tabStates.length > 0 ? tabStates[0].url : null;
    const timestamp = Date.now();
    const previous = await readCurrentCheckpoint();
    const checkpointId = generateCheckpointId(timestamp);

    const checkpoint: AutomationCheckpoint = {
      version: 1,
      timestamp,
      checkpointId,
      ...(previous?.checkpointId ? { parentId: previous.checkpointId } : {}),
      createdAt: timestamp,
      sessionId,
      ...(typeof args.label === 'string' && args.label.trim() ? { label: args.label.trim().slice(0, 120) } : {}),
      taskDescription: (args.taskDescription as string) || '',
      completedSteps,
      pendingSteps,
      currentUrl,
      tabStates,
      journalRange: { fromTs: previous?.timestamp ?? timestamp, toTs: timestamp },
      extractedData,
    };

    await fs.promises.mkdir(getCheckpointDir(), { recursive: true });
    await writeFileAtomicSafe(getCurrentCheckpointPath(), checkpoint);
    await writeCheckpointTimeline(checkpoint);

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
              checkpointId,
              parentId: checkpoint.parentId,
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

  if (action === 'list') {
    const { checkpoints, warnings } = await readTimelineEntries();
    const entries = checkpoints.map((cp) => toListEntry(cp)).filter((entry): entry is CheckpointListEntry => Boolean(entry));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              status: 'listed',
              checkpoints: entries,
              warnings,
              limits: { maxCheckpoints: parseRetentionLimit() },
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (action === 'load') {
    const checkpointId = typeof args.checkpointId === 'string' ? args.checkpointId : undefined;
    let cp = checkpointId ? await readCheckpointById(checkpointId) : await readCurrentCheckpoint();
    if (!cp && !checkpointId) {
      const timeline = await readTimelineEntries();
      cp = timeline.checkpoints[0] ?? null;
    }
    if (!cp) {
      return {
        content: [
          {
            type: 'text',
            text: checkpointId
              ? `No checkpoint found for checkpointId "${checkpointId}".`
              : 'No checkpoint found. Start fresh or save a checkpoint first.',
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
              checkpointId: cp.checkpointId,
              parentId: cp.parentId,
              savedAt: new Date(cp.timestamp).toISOString(),
              ageHours,
              sessionId: cp.sessionId,
              label: cp.label,
              taskDescription: cp.taskDescription,
              completedSteps: cp.completedSteps,
              pendingSteps: cp.pendingSteps,
              currentUrl: cp.currentUrl,
              tabStates: cp.tabStates,
              journalRange: cp.journalRange,
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
    const checkpointId = typeof args.checkpointId === 'string' ? args.checkpointId : undefined;
    if (checkpointId) {
      const safeId = sanitizeCheckpointId(checkpointId);
      if (!safeId) {
        return { content: [{ type: 'text', text: `Invalid checkpointId: ${checkpointId}` }], isError: true };
      }
      await fs.promises.unlink(timelinePathFor(safeId)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      const current = await readCurrentCheckpoint();
      if (current?.checkpointId === safeId) await fs.promises.unlink(getCurrentCheckpointPath()).catch(() => undefined);
      return { content: [{ type: 'text', text: `Checkpoint ${safeId} deleted.` }] };
    }

    const current = await readCurrentCheckpoint();
    const fallbackTimeline = current?.checkpointId ? null : (await readTimelineEntries()).checkpoints[0] ?? null;
    const timelineId = current?.checkpointId ?? fallbackTimeline?.checkpointId;
    let deleted = false;

    try {
      await fs.promises.unlink(getCurrentCheckpointPath());
      deleted = true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }

    if (timelineId) {
      await fs.promises.unlink(timelinePathFor(timelineId)).then(() => { deleted = true; }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }

    return {
      content: [{ type: 'text', text: deleted ? 'Checkpoint deleted.' : 'No checkpoint to delete.' }],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `Unknown action: ${action}. Use save, load, list, or delete.`,
      },
    ],
    isError: true,
  };
};

// ─── Registration ──────────────────────────────────────────────────────────

export function registerCheckpointTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
