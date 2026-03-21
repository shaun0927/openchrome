/**
 * Task Journal — automatic MCP tool call tracking for context recovery.
 * Records every tool call to daily JSONL files.
 * Part of #356: AI Agent Continuity.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface JournalEntry {
  ts: number;                    // Unix ms timestamp
  tool: string;                  // Tool name (e.g., "navigate", "read_page")
  sessionId: string;             // MCP session identifier
  tabId?: string;                // Target tab if applicable
  args: Record<string, unknown>; // Sanitized tool arguments
  durationMs: number;            // Execution time
  ok: boolean;                   // Success/failure
  summary: string;               // Human-readable 1-line summary
  milestone?: boolean;           // True for significant actions
}

/** Tools whose entire args are redacted */
const REDACT_TOOLS = new Set(['http_auth', 'cookies']);

/** Arg keys that are always redacted */
const REDACT_KEYS = /password|token|secret|credential|api[_-]?key/i;

/** Tools marked as milestones for priority in resume summaries */
const MILESTONE_TOOLS = new Set([
  'navigate', 'fill_form', 'workflow_init', 'execute_plan',
  'oc_session_snapshot', 'oc_stop', 'tabs_create', 'tabs_close',
]);

export class TaskJournal {
  private readonly dir: string;
  private readonly maxAgeDays: number;

  constructor(opts?: { dir?: string; maxAgeDays?: number }) {
    this.dir = opts?.dir || path.join(os.homedir(), '.openchrome', 'journal');
    this.maxAgeDays = opts?.maxAgeDays ?? 7;
  }

  /**
   * Initialize journal directory and prune old files.
   */
  async init(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await this.pruneOldFiles();
  }

  /**
   * Record a tool call. Called from mcp-server.ts after each tool execution.
   * Uses appendFileSync for crash safety (each line is self-contained).
   */
  record(entry: JournalEntry): void {
    try {
      const filename = `journal-${this.dateString()}.jsonl`;
      const filepath = path.join(this.dir, filename);
      fs.appendFileSync(filepath, JSON.stringify(entry) + '\n');
    } catch (err) {
      // Best-effort — don't crash the server if journal write fails
      console.error('[TaskJournal] Write failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Create a JournalEntry from a tool call.
   */
  createEntry(
    tool: string,
    sessionId: string,
    args: Record<string, unknown>,
    durationMs: number,
    ok: boolean,
  ): JournalEntry {
    return {
      ts: Date.now(),
      tool,
      sessionId,
      tabId: (args.tabId as string) || undefined,
      args: this.sanitizeArgs(tool, args),
      durationMs,
      ok,
      summary: this.generateSummary(tool, args, ok),
      milestone: MILESTONE_TOOLS.has(tool) || undefined,
    };
  }

  /**
   * Read recent entries from today and optionally yesterday.
   */
  getRecent(count: number = 20): JournalEntry[] {
    const entries: JournalEntry[] = [];
    const today = this.dateString();
    const yesterday = this.dateString(new Date(Date.now() - 86400000));

    for (const dateStr of [yesterday, today]) {
      const filepath = path.join(this.dir, `journal-${dateStr}.jsonl`);
      try {
        const content = fs.readFileSync(filepath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            entries.push(JSON.parse(trimmed) as JournalEntry);
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // File doesn't exist — skip
      }
    }

    return entries.slice(-count);
  }

  /**
   * Get milestone entries for resume summaries.
   */
  getMilestones(opts?: { since?: number; limit?: number }): JournalEntry[] {
    const entries = this.getRecent(500);
    let milestones = entries.filter(e => e.milestone);
    if (opts?.since) {
      milestones = milestones.filter(e => e.ts > opts.since!);
    }
    return milestones.slice(-(opts?.limit ?? 20));
  }

  /**
   * Get summary statistics.
   */
  getSummary(opts?: { since?: number }): {
    total: number;
    succeeded: number;
    failed: number;
    toolCounts: Record<string, number>;
    milestones: JournalEntry[];
    period: { start: number; end: number };
  } {
    let entries = this.getRecent(1000);
    if (opts?.since) {
      entries = entries.filter(e => e.ts > opts.since!);
    }

    const toolCounts: Record<string, number> = {};
    let succeeded = 0;
    let failed = 0;

    for (const e of entries) {
      toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
      if (e.ok) succeeded++; else failed++;
    }

    return {
      total: entries.length,
      succeeded,
      failed,
      toolCounts,
      milestones: entries.filter(e => e.milestone),
      period: {
        start: entries[0]?.ts || Date.now(),
        end: entries[entries.length - 1]?.ts || Date.now(),
      },
    };
  }

  /**
   * Sanitize tool arguments — redact sensitive fields.
   */
  sanitizeArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    if (REDACT_TOOLS.has(tool)) return { _redacted: true };
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (REDACT_KEYS.test(k)) {
        sanitized[k] = '[REDACTED]';
      } else {
        sanitized[k] = v;
      }
    }
    return sanitized;
  }

  /**
   * Generate human-readable 1-line summary.
   */
  generateSummary(tool: string, args: Record<string, unknown>, ok: boolean): string {
    const s = ok ? '✓' : '✗';
    switch (tool) {
      case 'navigate': return `${s} → ${args.url || 'unknown'}`;
      case 'read_page': return `${s} Read page`;
      case 'interact': return `${s} Click "${args.description || args.selector || ''}"`;
      case 'fill_form': {
        const fields = args.fields as Record<string, unknown> | undefined;
        return `${s} Fill form (${fields ? Object.keys(fields).length : 0} fields)`;
      }
      case 'find': return `${s} Find "${args.description || args.selector || ''}"`;
      case 'javascript_tool': return `${s} JS eval`;
      case 'tabs_create': return `${s} New tab${args.url ? ` → ${args.url}` : ''}`;
      case 'tabs_close': return `${s} Close tab`;
      case 'oc_stop': return `${s} Stop OpenChrome`;
      case 'oc_session_snapshot': return `${s} Snapshot saved`;
      case 'workflow_init': return `${s} Workflow started`;
      default: return `${s} ${tool}`;
    }
  }

  /**
   * Delete journal files older than maxAgeDays.
   */
  private async pruneOldFiles(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.dir);
      const cutoff = Date.now() - (this.maxAgeDays * 86400000);

      for (const file of files) {
        if (!file.startsWith('journal-') || !file.endsWith('.jsonl')) continue;
        const dateStr = file.slice(8, 18); // journal-YYYY-MM-DD.jsonl
        const fileDate = new Date(dateStr).getTime();
        if (fileDate && fileDate < cutoff) {
          await fs.promises.unlink(path.join(this.dir, file));
          console.error(`[TaskJournal] Pruned old journal: ${file}`);
        }
      }
    } catch {
      // Best-effort pruning
    }
  }

  private dateString(date?: Date): string {
    const d = date || new Date();
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }
}

/** Singleton */
let instance: TaskJournal | null = null;

export function getTaskJournal(): TaskJournal {
  if (!instance) {
    instance = new TaskJournal();
  }
  return instance;
}
