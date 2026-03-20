/**
 * Session Resume Tool — restores browser context after compaction.
 * Reads a snapshot, cross-references with live state, generates resume guide.
 * Part of #355: AI Agent Continuity.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

// ─── Shared Types (same as session-snapshot.ts) ────────────────────────────

interface SnapshotTab {
  targetId: string;
  workerId: string;
  sessionId: string;
  url: string;
  title: string;
}

interface SnapshotMemo {
  objective: string;
  currentStep: string;
  nextActions: string[];
  completedSteps?: string[];
  notes?: string;
}

interface SessionSnapshot {
  version: 1;
  id: string;
  timestamp: number;
  tabs: SnapshotTab[];
  memo: SnapshotMemo;
  label?: string;
}

// ─── Tab Status Analysis ───────────────────────────────────────────────────

type TabStatus = 'LIVE' | 'REMAPPED' | 'CLOSED';

interface TabAnalysis {
  saved: SnapshotTab;
  status: TabStatus;
  currentTargetId?: string;  // For REMAPPED tabs
  currentUrl?: string;       // Current URL if different
}

// ─── Tool Definition ───────────────────────────────────────────────────────

const definition: MCPToolDefinition = {
  name: 'oc_session_resume',
  description:
    'Restore working context after context compaction. ' +
    'Reads the last oc_session_snapshot, checks which tabs are still alive, ' +
    'and returns a resume guide with your objective, progress, and tab status. ' +
    'Call this after compaction to continue where you left off.',
  inputSchema: {
    type: 'object',
    properties: {
      snapshotId: {
        type: 'string',
        description: 'Specific snapshot ID to restore (default: latest)',
      },
    },
    required: [],
  },
};

// ─── Snapshot Loading ──────────────────────────────────────────────────────

export const SNAPSHOT_DIR = path.join(os.homedir(), '.openchrome', 'snapshots');

export function loadSnapshot(snapshotId?: string): SessionSnapshot | null {
  try {
    const filename = snapshotId ? `${snapshotId}.json` : 'latest.json';
    const filepath = path.join(SNAPSHOT_DIR, filename);
    const content = fs.readFileSync(filepath, 'utf-8');
    const snapshot = JSON.parse(content) as SessionSnapshot;

    if (snapshot.version !== 1) return null;
    return snapshot;
  } catch {
    return null;
  }
}

// ─── Tab Analysis ──────────────────────────────────────────────────────────

export async function analyzeTabs(savedTabs: SnapshotTab[]): Promise<TabAnalysis[]> {
  const results: TabAnalysis[] = [];
  const sessionManager = getSessionManager();

  for (const saved of savedTabs) {
    // Step 1: Try exact targetId match using the saved sessionId
    let foundLive = false;
    try {
      const page = await sessionManager.getPage(saved.sessionId, saved.targetId, saved.workerId);
      if (page) {
        const currentUrl = page.url() || 'about:blank';
        results.push({
          saved,
          status: 'LIVE',
          currentTargetId: saved.targetId,
          currentUrl,
        });
        foundLive = true;
      }
    } catch {
      // Target not found or session mismatch — try URL remapping below
    }

    if (foundLive) continue;

    // Step 2: Try URL-based remapping across all sessions/workers/targets
    let remapped = false;
    try {
      const allSessionInfos = sessionManager.getAllSessionInfos();

      outer:
      for (const sessionInfo of allSessionInfos) {
        for (const workerInfo of sessionInfo.workers) {
          const targetIds = sessionManager.getWorkerTargetIds(sessionInfo.id, workerInfo.id);
          for (const targetId of targetIds) {
            try {
              const page = await sessionManager.getPage(sessionInfo.id, targetId);
              if (page && page.url() === saved.url) {
                results.push({
                  saved,
                  status: 'REMAPPED',
                  currentTargetId: targetId,
                  currentUrl: page.url(),
                });
                remapped = true;
                break outer;
              }
            } catch {
              // Skip unreachable targets
            }
          }
        }
      }
    } catch {
      // Session manager error during URL scan — fall through to CLOSED
    }

    if (remapped) continue;

    // Step 3: Tab is gone
    results.push({
      saved,
      status: 'CLOSED',
    });
  }

  return results;
}

// ─── Resume Guide Generation ───────────────────────────────────────────────

export function generateResumeGuide(snapshot: SessionSnapshot, tabAnalysis: TabAnalysis[]): string {
  const lines: string[] = [];

  const age = Date.now() - snapshot.timestamp;
  const ageStr = age < 60000 ? `${Math.round(age / 1000)}s` :
                 age < 3600000 ? `${Math.round(age / 60000)}m` :
                 `${Math.round(age / 3600000)}h`;

  lines.push('=== CONTEXT RESTORED ===');
  lines.push('');
  lines.push(`Objective: ${snapshot.memo.objective}`);
  lines.push(`Last step: ${snapshot.memo.currentStep}`);
  lines.push(`Snapshot age: ${ageStr}${snapshot.label ? ` (${snapshot.label})` : ''}`);

  if (age > 24 * 3600000) {
    lines.push('WARNING: Snapshot is over 24 hours old. Tab states may be inaccurate.');
  }

  // Tab status
  const live = tabAnalysis.filter(t => t.status === 'LIVE');
  const remapped = tabAnalysis.filter(t => t.status === 'REMAPPED');
  const closed = tabAnalysis.filter(t => t.status === 'CLOSED');

  lines.push('');
  lines.push(`Tabs: ${live.length} LIVE, ${remapped.length} REMAPPED, ${closed.length} CLOSED`);

  if (tabAnalysis.length > 0) {
    lines.push('');
    for (const tab of tabAnalysis) {
      const statusLabel = tab.status === 'LIVE' ? 'LIVE    ' :
                          tab.status === 'REMAPPED' ? 'REMAPPED' :
                          'CLOSED  ';
      const url = tab.saved.url;
      const title = tab.saved.title ? ` "${tab.saved.title}"` : '';

      if (tab.status === 'REMAPPED') {
        lines.push(`  [${statusLabel}] ${tab.saved.targetId} -> ${tab.currentTargetId} ${url}${title}`);
      } else if (tab.status === 'CLOSED') {
        lines.push(`  [${statusLabel}] ${url}${title}`);
      } else {
        lines.push(`  [${statusLabel}] ${tab.currentTargetId} ${url}${title}`);
      }
    }
  }

  // Completed steps
  if (snapshot.memo.completedSteps && snapshot.memo.completedSteps.length > 0) {
    lines.push('');
    lines.push('Completed:');
    for (const step of snapshot.memo.completedSteps) {
      lines.push(`  - ${step}`);
    }
  }

  // Next actions
  if (snapshot.memo.nextActions.length > 0) {
    lines.push('');
    lines.push('Next actions:');
    snapshot.memo.nextActions.forEach((action, i) => {
      lines.push(`  ${i + 1}. ${action}`);
    });
  }

  // Notes
  if (snapshot.memo.notes) {
    lines.push('');
    lines.push(`Notes: ${snapshot.memo.notes}`);
  }

  return lines.join('\n');
}

// ─── Handler ───────────────────────────────────────────────────────────────

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const snapshotId = args.snapshotId as string | undefined;

  const snapshot = loadSnapshot(snapshotId);
  if (!snapshot) {
    return {
      content: [{
        type: 'text',
        text: 'No snapshot found.' +
          (snapshotId ? ` Snapshot "${snapshotId}" does not exist.` : '') +
          ' Use oc_session_snapshot to save state before long operations.',
      }],
    };
  }

  let tabAnalysis: TabAnalysis[];
  try {
    tabAnalysis = await analyzeTabs(snapshot.tabs);
  } catch {
    // Can't analyze tabs (Chrome disconnected) — return snapshot data as-is
    tabAnalysis = snapshot.tabs.map(tab => ({
      saved: tab,
      status: 'CLOSED' as TabStatus,
    }));
  }

  const guide = generateResumeGuide(snapshot, tabAnalysis);

  return {
    content: [{ type: 'text', text: guide }],
    _snapshotId: snapshot.id,
  };
};

// ─── Registration ──────────────────────────────────────────────────────────

export function registerSessionResumeTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
