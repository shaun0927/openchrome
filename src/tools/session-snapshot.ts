/**
 * Session Snapshot Tool — captures browser state for context recovery.
 * Part of #355: AI Agent Continuity.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { writeFileAtomicSafe } from '../utils/atomic-file';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SnapshotTab {
  targetId: string;
  workerId: string;
  sessionId: string;
  url: string;
  title: string;
}

export interface SnapshotMemo {
  objective: string;
  currentStep: string;
  nextActions: string[];
  completedSteps?: string[];
  notes?: string;
}

export interface SessionSnapshot {
  version: 1;
  id: string;
  timestamp: number;
  tabs: SnapshotTab[];
  memo: SnapshotMemo;
  label?: string;
}

// ─── Tool Definition ───────────────────────────────────────────────────────

const definition: MCPToolDefinition = {
  name: 'oc_session_snapshot',
  description:
    'Save browser state snapshot for context recovery after compaction. ' +
    'Captures open tabs, worker state, and your task memo. ' +
    'Use before long operations or periodically during multi-step tasks. ' +
    'Restore with oc_session_resume.',
  inputSchema: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: 'What you are trying to accomplish',
      },
      currentStep: {
        type: 'string',
        description: 'What step you are currently on',
      },
      nextActions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Planned next actions',
      },
      completedSteps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Steps already completed',
      },
      notes: {
        type: 'string',
        description: 'Additional context or notes',
      },
      label: {
        type: 'string',
        description: 'Optional label for this snapshot',
      },
    },
    required: ['objective', 'currentStep', 'nextActions'],
  },
};

// ─── Snapshot Directory ────────────────────────────────────────────────────

export const SNAPSHOT_DIR = path.join(os.homedir(), '.openchrome', 'snapshots');
export const MAX_SNAPSHOTS = 10;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function generateSnapshotId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const hex = Math.random().toString(16).slice(2, 6);
  return `snap-${ts}-${hex}`;
}

// ─── Tab Collection ────────────────────────────────────────────────────────

export async function collectTabs(): Promise<SnapshotTab[]> {
  const tabs: SnapshotTab[] = [];

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
                title = await page.title();
              } catch {
                title = '';
              }
            }
          } catch {
            // Page may be closed or crashed
          }

          tabs.push({
            targetId,
            workerId,
            sessionId,
            url,
            title,
          });
        }
      }
    }
  } catch (err) {
    // Session manager may not be initialized or Chrome not connected
    console.error('[SessionSnapshot] collectTabs error (graceful fallback):', err instanceof Error ? err.message : String(err));
  }

  return tabs;
}

// ─── File Management ───────────────────────────────────────────────────────

async function ensureDir(): Promise<void> {
  await fs.promises.mkdir(SNAPSHOT_DIR, { recursive: true });
}

export async function saveSnapshot(snapshot: SessionSnapshot): Promise<void> {
  await ensureDir();

  // Save as latest.json (atomic overwrite)
  const latestPath = path.join(SNAPSHOT_DIR, 'latest.json');
  await writeFileAtomicSafe(latestPath, snapshot);

  // Save history copy
  const historyPath = path.join(SNAPSHOT_DIR, `${snapshot.id}.json`);
  await writeFileAtomicSafe(historyPath, snapshot);

  // Prune old snapshots
  await pruneSnapshots();
}

export async function pruneSnapshots(): Promise<void> {
  try {
    const files = await fs.promises.readdir(SNAPSHOT_DIR);
    const snapFiles = files
      .filter(f => f.startsWith('snap-') && f.endsWith('.json'))
      .sort(); // Lexicographic sort = chronological for our ID format

    // Remove excess snapshots (keep MAX_SNAPSHOTS most recent)
    if (snapFiles.length > MAX_SNAPSHOTS) {
      const toRemove = snapFiles.slice(0, snapFiles.length - MAX_SNAPSHOTS);
      for (const file of toRemove) {
        await fs.promises.unlink(path.join(SNAPSHOT_DIR, file)).catch(() => {});
      }
    }

    // Remove snapshots older than MAX_AGE_MS
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const file of snapFiles) {
      const filePath = path.join(SNAPSHOT_DIR, file);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.unlink(filePath);
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // Best-effort pruning
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const memo: SnapshotMemo = {
    objective: args.objective as string,
    currentStep: args.currentStep as string,
    nextActions: (args.nextActions as string[]) || [],
    completedSteps: (args.completedSteps as string[]) || undefined,
    notes: (args.notes as string) || undefined,
  };

  const tabs = await collectTabs();
  const snapshotId = generateSnapshotId();

  const snapshot: SessionSnapshot = {
    version: 1,
    id: snapshotId,
    timestamp: Date.now(),
    tabs,
    memo,
    label: (args.label as string) || undefined,
  };

  await saveSnapshot(snapshot);

  const text = [
    `Snapshot saved: ${snapshotId}`,
    `Tabs: ${tabs.length}`,
    `Objective: ${memo.objective}`,
    `Step: ${memo.currentStep}`,
    `Next: ${memo.nextActions.join(', ')}`,
    '',
    'Use oc_session_resume to restore this context after compaction.',
  ].join('\n');

  return {
    content: [{ type: 'text', text }],
    _snapshotId: snapshotId,
  };
};

// ─── Registration ──────────────────────────────────────────────────────────

export function registerSessionSnapshotTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
