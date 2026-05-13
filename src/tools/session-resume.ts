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
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { CHECKPOINT_DIR, CHECKPOINT_FILE } from './checkpoint';

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


interface AutomationCheckpoint {
  version: 1;
  timestamp: number;
  taskDescription: string;
  completedSteps: string[];
  pendingSteps: string[];
  currentUrl: string | null;
  tabStates: Array<{ tabId: string; url: string; title: string }>;
  extractedData: Record<string, unknown>;
}

interface RecentJournalEntry {
  ts: number;
  tool: string;
  ok: boolean;
  summary: string;
}

export interface ResumeGuideContext {
  checkpoint?: AutomationCheckpoint | null;
  recentJournal?: RecentJournalEntry[];
  evidenceBundles?: Array<{ id?: string; path: string }>;
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
  annotations: TOOL_ANNOTATIONS.oc_session_resume,
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


// ─── Supplemental Artifact Loading ────────────────────────────────────────

export function loadCheckpoint(): AutomationCheckpoint | null {
  try {
    const filepath = path.join(CHECKPOINT_DIR, CHECKPOINT_FILE);
    const content = fs.readFileSync(filepath, 'utf-8');
    const checkpoint = JSON.parse(content) as AutomationCheckpoint;
    if (checkpoint.version !== 1) return null;
    if (!Array.isArray(checkpoint.completedSteps) || !Array.isArray(checkpoint.pendingSteps)) return null;
    if (!Array.isArray(checkpoint.tabStates) || typeof checkpoint.timestamp !== 'number') return null;
    return checkpoint;
  } catch {
    return null;
  }
}

export function loadRecentJournalEntries(limit = 8): RecentJournalEntry[] {
  const journalDir = path.join(os.homedir(), '.openchrome', 'journal');
  const dates = [
    new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    new Date().toISOString().slice(0, 10),
  ];
  const entries: RecentJournalEntry[] = [];

  for (const date of dates) {
    try {
      const content = fs.readFileSync(path.join(journalDir, `journal-${date}.jsonl`), 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as RecentJournalEntry;
          if (typeof parsed.ts === 'number' && typeof parsed.tool === 'string') {
            entries.push({
              ts: parsed.ts,
              tool: parsed.tool,
              ok: parsed.ok !== false,
              summary: typeof parsed.summary === 'string' ? parsed.summary : parsed.tool,
            });
          }
        } catch {
          // Skip malformed journal rows.
        }
      }
    } catch {
      // Missing journal files are normal.
    }
  }

  return entries.sort((a, b) => a.ts - b.ts).slice(-limit);
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

function formatRelativeAge(age: number): string {
  return age < 60000 ? `${Math.round(age / 1000)}s` :
         age < 3600000 ? `${Math.round(age / 60000)}m` :
         `${Math.round(age / 3600000)}h`;
}

export function generateResumeGuide(snapshot: SessionSnapshot, tabAnalysis: TabAnalysis[], context: ResumeGuideContext = {}): string {
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

  if (context.checkpoint) {
    const checkpointAge = Date.now() - context.checkpoint.timestamp;
    lines.push('');
    lines.push('Checkpoint:');
    lines.push(`  Task: ${context.checkpoint.taskDescription || '(not specified)'}`);
    lines.push(`  Age: ${formatRelativeAge(checkpointAge)}`);
    if (context.checkpoint.currentUrl) lines.push(`  Current URL: ${context.checkpoint.currentUrl}`);
    if (context.checkpoint.completedSteps.length > 0) {
      lines.push('  Completed from checkpoint:');
      context.checkpoint.completedSteps.slice(-5).forEach(step => lines.push(`    - ${step}`));
    }
    if (context.checkpoint.pendingSteps.length > 0) {
      lines.push('  Pending from checkpoint:');
      context.checkpoint.pendingSteps.slice(0, 5).forEach((step, i) => lines.push(`    ${i + 1}. ${step}`));
    }
    if (checkpointAge > 24 * 3600000) {
      lines.push('  WARNING: Checkpoint is over 24 hours old; verify live browser state before acting.');
    }
  }

  const recentJournal = context.recentJournal ?? [];
  if (recentJournal.length > 0) {
    const lastFailure = [...recentJournal].reverse().find(entry => !entry.ok);
    const lastSuccess = [...recentJournal].reverse().find(entry => entry.ok);
    lines.push('');
    lines.push('Recent tool activity:');
    if (lastSuccess) lines.push(`  Last success: ${lastSuccess.summary}`);
    if (lastFailure) lines.push(`  Last failure: ${lastFailure.summary}`);
    lines.push('  Recent entries:');
    recentJournal.slice(-5).forEach(entry => {
      lines.push(`    ${entry.ok ? '✓' : '✗'} ${entry.tool}: ${entry.summary}`);
    });
    if (lastFailure) {
      lines.push('  Avoid: repeating the last failed call with identical arguments until page state is refreshed or a different strategy is chosen.');
    }
  }

  if (context.evidenceBundles && context.evidenceBundles.length > 0) {
    lines.push('');
    lines.push('Evidence bundles:');
    for (const bundle of context.evidenceBundles.slice(-5)) {
      lines.push(`  - ${bundle.id ? `${bundle.id}: ` : ''}${bundle.path}`);
    }
  }

  lines.push('');
  lines.push('Recommended next safe action: verify the live tab state with read_page or tabs_context before mutating the page.');

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

  const guide = generateResumeGuide(snapshot, tabAnalysis, {
    checkpoint: loadCheckpoint(),
    recentJournal: loadRecentJournalEntries(),
  });

  return {
    content: [{ type: 'text', text: guide }],
    _snapshotId: snapshot.id,
  };
};

// ─── Registration ──────────────────────────────────────────────────────────

export function registerSessionResumeTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
