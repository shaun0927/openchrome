/**
 * Codegen aggregator (issue #836).
 *
 * Singleton owned by `src/index.ts` after `--codegen <format>` is parsed.
 * Accepts replay records emitted by per-tool handlers (for the nine
 * supported tools) and also captures the raw envelope of *every* tool
 * call so mcp-replay format covers the full session even for tools that
 * don't ship a snippet.
 *
 * On-disk layout under `~/.openchrome/codegen/`:
 *
 *   <session_id>.ts     -- puppeteer or playwright
 *   <session_id>.jsonl  -- mcp-replay (and always-on auto-capture)
 *
 * The aggregator writes the header on the first append and a footer on
 * `close()` so the resulting `.ts` parses end-to-end. Writes are append-
 * only and synchronous (file size per-session is bounded by a long-
 * running agent's tool-call count; lines are short).
 *
 * P2 invariant: when no aggregator is installed (default `--codegen off`),
 * `getCodegenAggregator()` returns `null` and per-tool handlers must not
 * emit a `replay` field. See `default-off.spec.ts` for the snapshot test.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { formatPuppeteer, PUPPETEER_FILE_HEADER, PUPPETEER_FILE_FOOTER, PUPPETEER_SUPPORTED_TOOLS } from './formatters/puppeteer';
import { formatPlaywright, PLAYWRIGHT_FILE_HEADER, PLAYWRIGHT_FILE_FOOTER, PLAYWRIGHT_SUPPORTED_TOOLS } from './formatters/playwright';
import { formatMcpReplay } from './formatters/mcp-replay';
import { getOriginalArgs as getOriginalArgsFromHook } from './secrets-hook';

export type CodegenFormat = 'off' | 'puppeteer' | 'playwright' | 'mcp-replay';

/**
 * The per-tool replay record. Mirrors the field shape that tool handlers
 * embed in their MCP responses and that #836's PR description specifies.
 */
export interface ReplayRecord {
  tool: string;
  args: Record<string, unknown>;
  puppeteer_snippet?: string;
  playwright_snippet?: string;
}

export interface CodegenAggregatorOptions {
  format: Exclude<CodegenFormat, 'off'>;
  /** Override the default `~/.openchrome/codegen` output directory. */
  outputDir?: string;
  /** Session id used as the file basename. Defaults to a fresh ulid-like string. */
  sessionId?: string;
}

/** Default directory used when no override is supplied. */
export function defaultCodegenDir(): string {
  return path.join(os.homedir(), '.openchrome', 'codegen');
}

/**
 * Returns a millisecond-precision id that is monotonic-within-process
 * and unique enough for filename use (we partition by session id, not
 * by date, so collisions only matter for the per-process default).
 */
function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, '0');
  return `${ts}-${rand}`;
}

/**
 * The aggregator. One instance per process when `--codegen` is set; held
 * in a module-level slot so per-tool handlers can reach it without
 * threading the reference through every call site.
 */
export class CodegenAggregator {
  readonly format: Exclude<CodegenFormat, 'off'>;
  readonly outputDir: string;
  readonly sessionId: string;
  private readonly tsPath: string | null;
  private readonly jsonlPath: string;
  private tsHeaderWritten = false;
  private jsonlHeaderWritten = false;
  private closed = false;
  private callCount = 0;

  constructor(options: CodegenAggregatorOptions) {
    this.format = options.format;
    this.outputDir = options.outputDir ?? defaultCodegenDir();
    this.sessionId = options.sessionId ?? generateSessionId();
    fs.mkdirSync(this.outputDir, { recursive: true });
    // mcp-replay only writes the jsonl; puppeteer/playwright write the .ts
    // and *also* the jsonl (auto-capture for non-9 tools).
    this.tsPath =
      this.format === 'mcp-replay'
        ? null
        : path.join(this.outputDir, `${this.sessionId}.ts`);
    this.jsonlPath = path.join(this.outputDir, `${this.sessionId}.jsonl`);
  }

  /** Path to the language-snippet file (null when format=mcp-replay). */
  get scriptPath(): string | null {
    return this.tsPath;
  }

  /** Path to the always-on JSONL envelope log. */
  get jsonlFilePath(): string {
    return this.jsonlPath;
  }

  /** Number of recorded tool calls. Used by tests and metrics. */
  get count(): number {
    return this.callCount;
  }

  /**
   * Build a `replay` field for a tool response. Returns `null` when the
   * tool is outside the 9-tool supported set OR when the format is
   * `mcp-replay` (which never emits per-tool snippets — only envelopes).
   *
   * Per-tool handlers call this AFTER they've assembled their own
   * arguments object. The aggregator queries the secrets-hook with the
   * provided `toolCallId` so pre-substitution placeholders survive (when
   * #834 is wired). The returned object is also recorded internally so
   * `recordToolCall` can write the matching script line.
   */
  buildReplay(
    tool: string,
    args: Record<string, unknown>,
    toolCallId?: string,
  ): ReplayRecord | null {
    if (this.closed) return null;
    if (this.format === 'mcp-replay') return null;

    const isSupported =
      this.format === 'puppeteer'
        ? PUPPETEER_SUPPORTED_TOOLS.has(tool)
        : PLAYWRIGHT_SUPPORTED_TOOLS.has(tool);
    if (!isSupported) return null;

    const effectiveArgs = toolCallId ? (getOriginalArgsFromHook(toolCallId) ?? args) : args;

    const record: ReplayRecord = {
      tool,
      args: effectiveArgs,
    };

    if (this.format === 'puppeteer') {
      const snippet = formatPuppeteer(tool, effectiveArgs);
      if (snippet) record.puppeteer_snippet = snippet;
    } else if (this.format === 'playwright') {
      const snippet = formatPlaywright(tool, effectiveArgs);
      if (snippet) record.playwright_snippet = snippet;
    }
    return record;
  }

  /**
   * Persist a single tool call. Called by the MCP server's tools/call
   * dispatcher for every tool, regardless of whether the tool itself
   * embedded a `replay` field. The always-on JSONL line provides
   * mcp-replay coverage for the non-9 tools. The .ts script-line is
   * written only for the 9 supported tools.
   */
  recordToolCall(
    tool: string,
    args: Record<string, unknown>,
    toolCallId?: string,
  ): void {
    if (this.closed) return;
    this.callCount += 1;

    const effectiveArgs = toolCallId ? (getOriginalArgsFromHook(toolCallId) ?? args) : args;

    // Always write to JSONL — auto-capture for any tool.
    try {
      if (!this.jsonlHeaderWritten) {
        this.jsonlHeaderWritten = true;
      }
      fs.appendFileSync(this.jsonlPath, `${formatMcpReplay(tool, effectiveArgs)}\n`, 'utf8');
    } catch (err) {
      console.error('[codegen] jsonl append failed:', err instanceof Error ? err.message : err);
    }

    // Per-language script line is gated on format + supported tool set.
    if (!this.tsPath) return;

    const snippet =
      this.format === 'puppeteer'
        ? formatPuppeteer(tool, effectiveArgs)
        : this.format === 'playwright'
          ? formatPlaywright(tool, effectiveArgs)
          : null;

    if (!snippet) return;

    try {
      if (!this.tsHeaderWritten) {
        const header =
          this.format === 'puppeteer' ? PUPPETEER_FILE_HEADER : PLAYWRIGHT_FILE_HEADER;
        fs.appendFileSync(this.tsPath, header, 'utf8');
        this.tsHeaderWritten = true;
      }
      fs.appendFileSync(this.tsPath, `${snippet}\n`, 'utf8');
    } catch (err) {
      console.error('[codegen] script append failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Close the session file. Writes the language-specific footer when at
   * least one snippet line was appended so the resulting TS parses. Safe
   * to call multiple times.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.tsPath && this.tsHeaderWritten) {
      const footer =
        this.format === 'puppeteer' ? PUPPETEER_FILE_FOOTER : PLAYWRIGHT_FILE_FOOTER;
      try {
        fs.appendFileSync(this.tsPath, footer, 'utf8');
      } catch (err) {
        console.error('[codegen] footer append failed:', err instanceof Error ? err.message : err);
      }
    }
  }
}

// ─── Module-level singleton slot ─────────────────────────────────────────

let active: CodegenAggregator | null = null;

/**
 * Install the active aggregator. Called once by `src/index.ts` after the
 * CLI flag is parsed. Returns the previous instance so tests can save and
 * restore.
 */
export function setCodegenAggregator(
  next: CodegenAggregator | null,
): CodegenAggregator | null {
  const prev = active;
  active = next;
  return prev;
}

/**
 * Read the active aggregator. Returns `null` when codegen is off — per-tool
 * handlers MUST check for null before constructing a `replay` field so the
 * default response shape is byte-identical to v1.11.0 (acceptance criterion).
 */
export function getCodegenAggregator(): CodegenAggregator | null {
  return active;
}

/**
 * Parse a CLI string into a CodegenFormat. Returns `'off'` for unknown
 * values so the CLI can fall back to the default without crashing.
 */
export function parseCodegenFormat(raw: string | undefined): CodegenFormat {
  if (!raw) return 'off';
  const v = raw.toLowerCase();
  if (v === 'off' || v === 'puppeteer' || v === 'playwright' || v === 'mcp-replay') {
    return v;
  }
  return 'off';
}
