/**
 * Task Journal — automatic MCP tool call tracking for context recovery.
 * Records every tool call to daily JSONL files.
 * Part of #356: AI Agent Continuity.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type JournalFailureClass =
  | "stale_ref"
  | "auth_redirect"
  | "captcha_or_waf"
  | "timeout"
  | "network_error"
  | "empty_result"
  | "contract_failed"
  | "non_progress_loop"
  | "unknown";

export interface JournalEntry {
  ts: number; // Unix ms timestamp
  tool: string; // Tool name (e.g., "navigate", "read_page")
  sessionId: string; // MCP session identifier
  tabId?: string; // Target tab if applicable
  args: Record<string, unknown>; // Sanitized tool arguments
  durationMs: number; // Execution time
  ok: boolean; // Success/failure
  summary: string; // Human-readable 1-line summary
  milestone?: boolean; // True for significant actions
  failureClass?: JournalFailureClass; // Deterministic failure class for failed/non-progress calls
  errorFingerprint?: string; // Normalized, secret-safe error/result fingerprint
  resultSummary?: string; // Optional sanitized result/error summary for classification
}

/** Tools whose entire args are redacted */
const REDACT_TOOLS = new Set(["http_auth", "cookies"]);

/** Arg keys that are always redacted */
const REDACT_KEYS = /password|token|secret|credential|api[_-]?key/i;

/** Tools marked as milestones for priority in resume summaries */
const MILESTONE_TOOLS = new Set([
  "navigate",
  "fill_form",
  "workflow_init",
  "execute_plan",
  "oc_session_snapshot",
  "oc_stop",
  "tabs_create",
  "tabs_close",
]);

const PROGRESS_TOOLS = new Set([
  "navigate",
  "tabs_create",
  "tabs_close",
  "fill_form",
  "interact",
  "form_input",
  "javascript_tool",
  "execute_plan",
  "workflow_init",
  "worker_complete",
  "oc_session_snapshot",
  "oc_checkpoint",
]);

const OBSERVATION_TOOLS = new Set([
  "read_page",
  "tabs_context",
  "page_content",
  "page_screenshot",
]);

export class TaskJournal {
  private readonly dir: string;
  private readonly maxAgeDays: number;

  constructor(opts?: { dir?: string; maxAgeDays?: number }) {
    this.dir = opts?.dir || path.join(os.homedir(), ".openchrome", "journal");
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
      fs.appendFileSync(filepath, JSON.stringify(entry) + "\n");
    } catch (err) {
      // Best-effort — don't crash the server if journal write fails
      console.error(
        "[TaskJournal] Write failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Record an output-handle creation event (#887). Best-effort sidecar log.
   */
  recordOutputHandle(event: Record<string, unknown>): void {
    try {
      const filename = `journal-${this.dateString()}.jsonl`;
      const filepath = path.join(this.dir, filename);
      fs.appendFileSync(filepath, JSON.stringify(event) + "\n");
    } catch (err) {
      console.error(
        "[TaskJournal] Output-handle write failed:",
        err instanceof Error ? err.message : err,
      );
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
    resultSummary?: string,
  ): JournalEntry {
    const sanitizedResult = resultSummary
      ? this.sanitizeResultSummary(resultSummary)
      : undefined;
    const entry: JournalEntry = {
      ts: Date.now(),
      tool,
      sessionId,
      tabId: (args.tabId as string) || undefined,
      args: this.sanitizeArgs(tool, args),
      durationMs,
      ok,
      summary: this.generateSummary(tool, args, ok),
      milestone: MILESTONE_TOOLS.has(tool) || undefined,
      resultSummary: sanitizedResult,
    };

    const failureClass = this.classifyFailure(entry);
    if (failureClass) {
      entry.failureClass = failureClass;
      entry.errorFingerprint = this.fingerprintEntry(entry);
    }

    return entry;
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
        const content = fs.readFileSync(filepath, "utf-8");
        for (const line of content.split("\n")) {
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
    let milestones = entries.filter((e) => e.milestone);
    if (opts?.since) {
      milestones = milestones.filter((e) => e.ts > opts.since!);
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
    failureClasses: Record<JournalFailureClass, number>;
    repeatedErrorFingerprints: Array<{
      fingerprint: string;
      count: number;
      failureClass: JournalFailureClass;
    }>;
    lastProgressTool?: { tool: string; summary: string; ts: number };
    recentNonProgressTools: Array<{
      tool: string;
      summary: string;
      failureClass: JournalFailureClass;
      ts: number;
    }>;
    candidateRecoveryHints: string[];
    period: { start: number; end: number };
  } {
    let entries = this.getRecent(1000);
    if (opts?.since) {
      entries = entries.filter((e) => e.ts > opts.since!);
    }

    const toolCounts: Record<string, number> = {};
    const failureClasses = emptyFailureClassCounts();
    const fingerprintCounts = new Map<
      string,
      { count: number; failureClass: JournalFailureClass }
    >();
    const recentNonProgressTools: Array<{
      tool: string;
      summary: string;
      failureClass: JournalFailureClass;
      ts: number;
    }> = [];
    let lastProgressTool:
      | { tool: string; summary: string; ts: number }
      | undefined;
    let succeeded = 0;
    let failed = 0;

    for (const e of entries) {
      toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
      if (e.ok) succeeded++;
      else failed++;

      if (this.isProgressEntry(e)) {
        lastProgressTool = { tool: e.tool, summary: e.summary, ts: e.ts };
      }

      const failureClass = e.failureClass ?? this.classifyFailure(e);
      if (failureClass) {
        failureClasses[failureClass]++;
        recentNonProgressTools.push({
          tool: e.tool,
          summary: e.summary,
          failureClass,
          ts: e.ts,
        });
        const fingerprint =
          e.errorFingerprint ?? this.fingerprintEntry({ ...e, failureClass });
        const current = fingerprintCounts.get(fingerprint) ?? {
          count: 0,
          failureClass,
        };
        current.count++;
        fingerprintCounts.set(fingerprint, current);
      }
    }

    const repeatedErrorFingerprints = Array.from(fingerprintCounts.entries())
      .filter(([, value]) => value.count > 1)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([fingerprint, value]) => ({
        fingerprint,
        count: value.count,
        failureClass: value.failureClass,
      }));

    return {
      total: entries.length,
      succeeded,
      failed,
      toolCounts,
      milestones: entries.filter((e) => e.milestone),
      failureClasses,
      repeatedErrorFingerprints,
      lastProgressTool,
      recentNonProgressTools: recentNonProgressTools.slice(-5),
      candidateRecoveryHints: buildCandidateRecoveryHints(failureClasses),
      period: {
        start: entries[0]?.ts || Date.now(),
        end: entries[entries.length - 1]?.ts || Date.now(),
      },
    };
  }

  /**
   * Sanitize tool arguments — redact sensitive fields.
   */
  sanitizeResultSummary(text: string): string {
    return text
      .replace(
        /(["'])(password|token|secret|credential|api[_-]?key)\1\s*:\s*(["'])(?:\\.|(?!\3).)*\3/gi,
        (_match, keyQuote: string, key: string, valueQuote: string) =>
          `${keyQuote}${key}${keyQuote}:${valueQuote}[REDACTED]${valueQuote}`,
      )
      .replace(
        /(password|token|secret|credential|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
        "$1=[REDACTED]",
      )
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .slice(0, 500);
  }

  sanitizeArgs(
    tool: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (REDACT_TOOLS.has(tool)) return { _redacted: true };
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (REDACT_KEYS.test(k)) {
        sanitized[k] = "[REDACTED]";
      } else {
        sanitized[k] = v;
      }
    }
    return sanitized;
  }

  classifyFailure(entry: JournalEntry): JournalFailureClass | null {
    const text =
      `${entry.tool} ${stripUrls(entry.summary)} ${entry.resultSummary ?? ""}`.toLowerCase();
    if (entry.ok && !hasOkNonProgressSignal(text)) return null;

    if (
      /(no longer available|target .*not found|tab .*not found|ref_\d+|backendnodeid|stale\s+(?:ref|reference|element|node)|(?:ref|reference|element|node)\s+(?:is\s+)?stale)/i.test(
        text,
      )
    )
      return "stale_ref";
    if (
      /(authredirect|auth_redirect_required|login page detected|redirected to (?:login|sign[- ]?in)|please sign[- ]?in|sign[- ]?in required|sign[- ]?in to continue|must sign[- ]?in|sign[- ]?in to (?:access|view)|unauthorized|\b401\b)/i.test(
        text,
      )
    )
      return "auth_redirect";
    if (
      /(captcha|waf|cloudflare|access denied|bot-check|bot verification|been blocked|forbidden|403)/i.test(
        text,
      )
    )
      return "captcha_or_waf";
    if (/(timed out|timeout|navigation timeout)/i.test(text)) return "timeout";
    if (
      /(net::err_|network error|connection reset|econnreset|enotfound|eai_again|socket hang up)/i.test(
        text,
      )
    )
      return "network_error";
    if (
      /(oc_assert|assertion|contract|verdict.*fail|failed_assertions|inconclusive)/i.test(
        text,
      )
    )
      return "contract_failed";
    if (
      /(empty result|no data|no rows|no matches|not found|missing selector|selector .*missing)/i.test(
        text,
      )
    )
      return "empty_result";
    if (
      /(not making progress|stuck|stalling|non-progress|same action|repeated)/i.test(
        text,
      )
    )
      return "non_progress_loop";

    return entry.ok ? null : "unknown";
  }

  private isProgressEntry(entry: JournalEntry): boolean {
    if (!entry.ok) return false;
    if (OBSERVATION_TOOLS.has(entry.tool)) return false;
    if (!PROGRESS_TOOLS.has(entry.tool)) return false;
    return !this.classifyFailure(entry);
  }

  private fingerprintEntry(entry: JournalEntry): string {
    const raw = `${entry.failureClass ?? "unknown"}:${entry.tool}:${entry.resultSummary ?? entry.summary}`;
    return raw
      .toLowerCase()
      .replace(/https?:\/\/[^\s)]+/g, "{url}")
      .replace(/ref_\d+/g, "ref_{n}")
      .replace(/\b[0-9a-f]{8,}\b/g, "{id}")
      .replace(/\d+/g, "{n}")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  /**
   * Generate human-readable 1-line summary.
   */
  generateSummary(
    tool: string,
    args: Record<string, unknown>,
    ok: boolean,
  ): string {
    const s = ok ? "✓" : "✗";
    switch (tool) {
      case "navigate":
        return `${s} → ${args.url || "unknown"}`;
      case "read_page":
        return `${s} Read page`;
      case "interact":
        return `${s} Click "${args.description || args.selector || ""}"`;
      case "fill_form": {
        const fields = args.fields as Record<string, unknown> | undefined;
        return `${s} Fill form (${fields ? Object.keys(fields).length : 0} fields)`;
      }
      case "find":
        return `${s} Find "${args.description || args.selector || ""}"`;
      case "javascript_tool":
        return `${s} JS eval`;
      case "tabs_create":
        return `${s} New tab${args.url ? ` → ${args.url}` : ""}`;
      case "tabs_close":
        return `${s} Close tab`;
      case "oc_stop":
        return `${s} Stop OpenChrome`;
      case "oc_session_snapshot":
        return `${s} Snapshot saved`;
      case "workflow_init":
        return `${s} Workflow started`;
      default:
        return `${s} ${tool}`;
    }
  }

  /**
   * Delete journal files older than maxAgeDays.
   */
  private async pruneOldFiles(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.dir);
      const cutoff = Date.now() - this.maxAgeDays * 86400000;

      for (const file of files) {
        if (!file.startsWith("journal-") || !file.endsWith(".jsonl")) continue;
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

function emptyFailureClassCounts(): Record<JournalFailureClass, number> {
  return {
    stale_ref: 0,
    auth_redirect: 0,
    captcha_or_waf: 0,
    timeout: 0,
    network_error: 0,
    empty_result: 0,
    contract_failed: 0,
    non_progress_loop: 0,
    unknown: 0,
  };
}

function stripUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s)]+/gi, '[url]');
}

function hasOkNonProgressSignal(text: string): boolean {
  return /(auth_redirect_required|failed_assertions|inconclusive|contract_failed|assertion_failed)/i.test(text);
}

function buildCandidateRecoveryHints(
  counts: Record<JournalFailureClass, number>,
): string[] {
  const hints: string[] = [];
  if (counts.stale_ref > 0)
    hints.push("Refresh page state with read_page before retrying stale refs.");
  if (counts.auth_redirect > 0)
    hints.push(
      "Verify authentication in a headed or persistent-profile session before retrying protected pages.",
    );
  if (counts.captcha_or_waf > 0)
    hints.push(
      "Stop repeated automation and use headed fallback or user-assisted verification for CAPTCHA/WAF blocks.",
    );
  if (counts.timeout > 0)
    hints.push(
      "Check partial page state with read_page and use shorter wait conditions before retrying timeout-prone actions.",
    );
  if (counts.network_error > 0)
    hints.push(
      "Retry after network recovery and inspect connection health before continuing.",
    );
  if (counts.empty_result > 0)
    hints.push(
      "Re-read the page and verify selectors or extraction criteria before repeating the same query.",
    );
  if (counts.contract_failed > 0)
    hints.push(
      "Inspect failed assertions and collect fresh evidence before continuing the plan.",
    );
  if (counts.non_progress_loop > 0)
    hints.push(
      "Change strategy instead of repeating the same observe/retry loop.",
    );
  return hints.slice(0, 5);
}

/** Singleton */
let instance: TaskJournal | null = null;

export function getTaskJournal(): TaskJournal {
  if (!instance) {
    instance = new TaskJournal();
  }
  return instance;
}
