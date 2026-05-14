/**
 * MCP Protocol Types - Ported from extension
 */

import type { Principal } from '../auth/api-key-types';

export interface MCPRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  // Per JSON-RPC 2.0 §5.1, `id` MUST be `null` for errors detected before any
  // per-request id can be parsed (e.g. malformed batch envelope, batch-level
  // rejection). Active responses always echo the client-provided id.
  id: number | string | null;
  result?: MCPResult;
  error?: MCPError;
}

export interface MCPResult {
  [key: string]: unknown;
  content?: MCPContent[];
  /**
   * Typed structured result alongside `content[]` (MCP spec
   * `structuredContent`). When the tool declares an `outputSchema`, the
   * returned object MUST validate against it. For backward compatibility
   * with clients that only read `content[]`, tools should populate BOTH:
   * `content[0].text` contains `JSON.stringify(structuredContent)` (or a
   * human-readable variant), and `structuredContent` carries the typed
   * object. `JSON.parse(content[0].text)` deep-equals `structuredContent`
   * is the wire-format invariant enforced per-tool by unit tests.
   */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface MCPContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

export const TOOL_CAPABILITIES = [
  'core',
  'crawl',
  'recording',
  'workflow',
  'storage',
  'profile',
  'totp',
  'pilot',
] as const;

/** Capability group a tool belongs to. Used by --tools-only / --disable-tools CLI flags. */
export type ToolCapability = typeof TOOL_CAPABILITIES[number];

/**
 * Allowed category values for MCPToolDefinition.category.
 * Used by scripts/gen-capability-map.ts to group tools in the generated
 * docs/agent/capability-map.md preamble.
 *
 * Values: navigation | dom | interact | forms | js | tabs | storage |
 *         profile | lifecycle | observability | evidence | recording |
 *         pilot | misc
 */
export type ToolCategory =
  | 'navigation'
  | 'dom'
  | 'interact'
  | 'forms'
  | 'js'
  | 'tabs'
  | 'storage'
  | 'profile'
  | 'lifecycle'
  | 'observability'
  | 'evidence'
  | 'recording'
  | 'pilot'
  | 'misc';

/**
 * JSON-Schema-Draft-7 shape used for both `inputSchema` and the optional
 * `outputSchema` on `MCPToolDefinition`. The runtime validator only inspects
 * `type === 'object'` schemas — list/scalar top-level shapes are intentionally
 * not allowed at the tool boundary.
 */
export interface MCPObjectSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}


/**
 * Tool annotations per MCP spec.
 *
 * Semantics are **per-tool, worst-case** — they describe the most destructive /
 * least pure behavior the tool can produce across all valid input combinations,
 * not the typical or default behavior.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: MCPObjectSchema;
  /**
   * Optional grouping category for the LLM capability-map preamble.
   * Defaults to "misc" when absent. See ToolCategory for allowed values.
   */
  category?: ToolCategory;
  /**
   * Optional MCP-spec `outputSchema`. When declared, callers can validate the
   * tool's `structuredContent` result against this schema. Tools that opt in
   * MUST populate `MCPResult.structuredContent` AND maintain the wire-format
   * invariant: `JSON.parse(content[0].text)` deep-equals `structuredContent`.
   * Tools without `outputSchema` continue to return free-form `content[]`.
   */
  outputSchema?: MCPObjectSchema;
  /** Optional MCP-spec tool annotations. */
  annotations?: ToolAnnotations;
  /**
   * Capability group this tool belongs to. Absent or undefined → defaults to 'core'.
   * Used by --tools-only / --disable-tools CLI flags to gate tool visibility.
   */
  capability?: ToolCapability;
}

/**
 * Context passed to tool handlers for budget-aware execution.
 * Tools can use getRemainingBudget() to check how much time remains
 * before the tool execution timeout fires.
 *
 * The optional `signal` is wired by the transport layer to the underlying
 * HTTP request lifecycle so that tool calls abort when the client disconnects
 * (see issue #8 — B-2: Tool-call AbortSignal propagation).
 */
/**
 * Progress update emitted by a tool handler.
 *
 * Mirrors the MCP-spec `notifications/progress` payload (less the
 * `progressToken`, which is injected by the dispatcher). Long-running tools
 * use this to report incremental status without changing their final
 * response shape.
 */
export interface ToolProgress {
  /** Monotonic non-decreasing progress value. Often a count (e.g. pages done) or a percentage. */
  progress: number;
  /** Total expected at completion, if known. Combined with `progress` clients can render a percentage. */
  total?: number;
  /** Short human-readable substep (≤ 120 chars recommended). */
  message?: string;
}


export interface ToolContext {
  /** When the tool handler started executing */
  startTime: number;
  /** Total budget in milliseconds (default: DEFAULT_TOOL_EXECUTION_TIMEOUT_MS) */
  deadlineMs: number;
  /** AbortSignal that fires when the originating HTTP request is closed. */
  signal?: AbortSignal;
  /** Transport-authenticated caller principal. Not forgeable via tool args. */
  principal?: Principal;
  /** Client capabilities advertised during initialize, scoped to this MCP session when known. */
  clientCapabilities?: { roots?: object; sampling?: object; elicitation?: object };
  /**
   * Send a request back to the connected MCP client (for spec features such
   * as roots, sampling, and elicitation). Tools must check clientCapabilities
   * and provide a safe fallback when the relevant capability is absent.
   */
  requestClient?: <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<T>;
  /**
   * Emit a progress update for the in-flight tool call.
   *
   * Populated by the dispatcher only when the client passed
   * `params._meta.progressToken` on `tools/call` — absent otherwise. Tools
   * MUST tolerate `reportProgress === undefined` (no-op semantically).
   *
   * Implementations coalesce updates per-token to at most one notification
   * per 100 ms; callers can fire freely. Updates are best-effort —
   * notification failures are swallowed so they cannot break the parent
   * tool call. Cancellation is independent: callers MUST still check
   * `throwIfAborted(ctx)` separately.
   */
  reportProgress?: (update: ToolProgress) => void;
}

/** Returns the number of milliseconds remaining before the tool deadline. */
export function getRemainingBudget(ctx: ToolContext): number {
  return Math.max(0, ctx.deadlineMs - (Date.now() - ctx.startTime));
}

/** Returns true if at least `needed` ms remain before the tool deadline. */
export function hasBudget(ctx: ToolContext, needed = 0): boolean {
  return getRemainingBudget(ctx) > needed;
}

/** True when the optional ToolContext signal has been aborted. */
export function isAborted(ctx?: ToolContext): boolean {
  return ctx?.signal?.aborted === true;
}

/** Throws the AbortSignal reason if the context's signal is aborted. */
export function throwIfAborted(ctx?: ToolContext): void {
  if (ctx?.signal?.aborted) {
    throw ctx.signal.reason instanceof Error
      ? ctx.signal.reason
      : new Error(String(ctx.signal.reason ?? 'Aborted'));
  }
}

export type ToolHandler = (
  sessionId: string,
  params: Record<string, unknown>,
  context?: ToolContext
) => Promise<MCPResult>;

export interface ToolRegistry {
  name: string;
  handler: ToolHandler;
  definition: MCPToolDefinition;
  /** When true, timeout errors return isError:false (tool produced useful partial state). */
  timeoutRecoverable?: boolean;
}

export const MCPErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** LLM-side override for compression level on individual tool calls */
export type CompressionOverride = 'none' | 'light' | 'aggressive';
