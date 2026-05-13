/**
 * RecoveryTrajectoryLedger — bounded, best-effort telemetry for tool attempts.
 *
 * Records compact JSONL nodes that describe successful, failed, and recovered
 * attempts without storing raw secrets, cookies, headers, screenshots, or full
 * DOM payloads. The ledger is intentionally passive: it never replays actions
 * or changes browser behavior.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type RecoveryResultStatus = 'success' | 'error' | 'no_progress' | 'recovered' | 'aborted';
export type RecoveryProgressStatus = 'progressing' | 'stalling' | 'stuck' | 'unknown';

export interface RecoveryTrajectoryNodeInput {
  sessionId: string;
  workflowId?: string;
  tabId?: string;
  parentNodeId?: string;
  toolName: string;
  args?: Record<string, unknown>;
  resultStatus: RecoveryResultStatus;
  progressStatus?: RecoveryProgressStatus;
  error?: string;
  result?: Record<string, unknown>;
  failureFingerprint?: string;
  recoveryTool?: string;
  evidenceHandle?: string;
  observationSummary?: string;
  reward?: number | null;
}

export interface RecoveryTrajectoryNode {
  nodeId: string;
  timestamp: number;
  sessionId: string;
  workflowId?: string;
  tabId?: string;
  parentNodeId?: string;
  toolName: string;
  argsSummary?: Record<string, unknown>;
  resultStatus: RecoveryResultStatus;
  progressStatus: RecoveryProgressStatus;
  failureFingerprint?: string;
  recoveryTool?: string;
  evidenceHandle?: string;
  observationSummary?: string;
  reward?: number | null;
}

export interface RecoveryTrajectoryLedgerOptions {
  dirPath?: string;
  fileName?: string;
  maxNodes?: number;
  maxNodeBytes?: number;
  maxFileBytes?: number;
}

const DEFAULT_MAX_NODES = 500;
const DEFAULT_MAX_NODE_BYTES = 4096;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const SUMMARY_MAX_CHARS = 500;
const REDACTED = '[REDACTED]';
const HASHED_PREFIX = 'sha256:';

const SENSITIVE_KEY_RE = /(^|[_-])(password|passwd|pass|pwd|secret|token|api[_-]?key|authorization|auth|cookie|set-cookie|session|credential|private[_-]?key|otp|totp|pin)($|[_-])/i;
const LARGE_VALUE_KEY_RE = /(html|dom|screenshot|image|data|body|content|headers?)/i;

export class RecoveryTrajectoryLedger {
  private readonly dirPath: string;
  private readonly filePath: string;
  private readonly maxNodes: number;
  private readonly maxNodeBytes: number;
  private readonly maxFileBytes: number;
  private readonly maxSessionIndexEntries: number;
  private lastNodeBySession = new Map<string, string>();
  private lastNodeByContext = new Map<string, RecoveryTrajectoryNode>();
  private pendingNodes: RecoveryTrajectoryNode[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: RecoveryTrajectoryLedgerOptions = {}) {
    this.dirPath = options.dirPath ?? path.join(process.cwd(), '.openchrome', 'recovery');
    this.filePath = path.join(this.dirPath, options.fileName ?? 'trajectory.jsonl');
    this.maxNodes = Math.max(1, options.maxNodes ?? readIntEnv('OPENCHROME_RECOVERY_LEDGER_MAX_NODES', DEFAULT_MAX_NODES));
    this.maxNodeBytes = Math.max(512, options.maxNodeBytes ?? readIntEnv('OPENCHROME_RECOVERY_LEDGER_MAX_NODE_BYTES', DEFAULT_MAX_NODE_BYTES));
    this.maxFileBytes = Math.max(this.maxNodeBytes, options.maxFileBytes ?? readIntEnv('OPENCHROME_RECOVERY_LEDGER_MAX_FILE_BYTES', DEFAULT_MAX_FILE_BYTES));
    this.maxSessionIndexEntries = Math.max(16, this.maxNodes);
  }

  getPath(): string {
    return this.filePath;
  }

  /** Best-effort append. Returns the built node when persistence is queued, null when skipped before queueing. */
  record(input: RecoveryTrajectoryNodeInput): RecoveryTrajectoryNode | null {
    try {
      const node = this.buildNode(input);
      const serialized = this.serializeBounded(node);
      this.lastNodeBySession.delete(input.sessionId);
      this.lastNodeBySession.set(input.sessionId, node.nodeId);
      this.lastNodeByContext.delete(contextKey(input.sessionId, node.tabId));
      this.lastNodeByContext.set(contextKey(input.sessionId, node.tabId), node);
      this.pruneSessionIndex();
      this.pendingNodes.push(node);
      this.prunePendingNodes();
      this.queuePersist(node, serialized);
      return node;
    } catch (err) {
      console.error(`[RecoveryTrajectoryLedger] record skipped: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  readRecent(limit = 50, sessionId?: string): RecoveryTrajectoryNode[] {
    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      const nodes = content.trim().length === 0
        ? []
        : content.trim().split('\n').map((line) => JSON.parse(line) as RecoveryTrajectoryNode);
      const merged = this.mergePending(nodes);
      const filtered = sessionId ? merged.filter((n) => n.sessionId === sessionId) : merged;
      return filtered.slice(-Math.max(0, limit));
    } catch {
      const filtered = sessionId ? this.pendingNodes.filter((n) => n.sessionId === sessionId) : this.pendingNodes;
      return filtered.slice(-Math.max(0, limit));
    }
  }

  /** Return the last in-memory node for this session/tab without touching disk. */
  getLastNode(sessionId: string, tabId?: string): RecoveryTrajectoryNode | undefined {
    return this.lastNodeByContext.get(contextKey(sessionId, tabId));
  }

  /** Test hook for queued best-effort writes. Not needed by normal callers. */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private buildNode(input: RecoveryTrajectoryNodeInput): RecoveryTrajectoryNode {
    const parentNodeId = input.parentNodeId ?? this.lastNodeBySession.get(input.sessionId);
    const observationSummary = input.observationSummary
      ?? summarizeResult(input.result)
      ?? summarizeText(input.error);
    const failureFingerprint = input.failureFingerprint
      ?? (input.error ? fingerprint(input.error) : undefined);
    const tabId = input.tabId ?? readString(input.args?.tabId);

    return pruneUndefined({
      nodeId: crypto.randomUUID(),
      timestamp: Date.now(),
      sessionId: input.sessionId,
      workflowId: input.workflowId,
      tabId,
      parentNodeId,
      toolName: input.toolName,
      argsSummary: summarizeArgs(input.args),
      resultStatus: input.resultStatus,
      progressStatus: input.progressStatus ?? 'unknown',
      failureFingerprint,
      recoveryTool: input.recoveryTool,
      evidenceHandle: input.evidenceHandle,
      observationSummary,
      reward: input.reward,
    });
  }

  private serializeBounded(node: RecoveryTrajectoryNode): string {
    let current = node;
    let json = JSON.stringify(current);
    if (Buffer.byteLength(json, 'utf8') <= this.maxNodeBytes) return json;

    current = {
      ...current,
      observationSummary: truncate(current.observationSummary, 160),
      argsSummary: compactObject(current.argsSummary),
    };
    json = JSON.stringify(current);
    if (Buffer.byteLength(json, 'utf8') <= this.maxNodeBytes) return json;

    current = pruneUndefined({
      nodeId: current.nodeId,
      timestamp: current.timestamp,
      sessionId: current.sessionId,
      tabId: current.tabId,
      parentNodeId: current.parentNodeId,
      toolName: current.toolName,
      resultStatus: current.resultStatus,
      progressStatus: current.progressStatus,
      failureFingerprint: current.failureFingerprint,
      observationSummary: truncate(current.observationSummary, 80),
      reward: current.reward,
    });
    json = JSON.stringify(current);
    if (Buffer.byteLength(json, 'utf8') <= this.maxNodeBytes) return json;

    return JSON.stringify({
      nodeId: current.nodeId,
      timestamp: current.timestamp,
      sessionId: current.sessionId,
      toolName: current.toolName,
      resultStatus: current.resultStatus,
      progressStatus: current.progressStatus,
    });
  }

  private queuePersist(node: RecoveryTrajectoryNode, serialized: string): void {
    this.writeQueue = this.writeQueue
      .then(async () => {
        await fs.promises.mkdir(this.dirPath, { recursive: true });
        await fs.promises.appendFile(this.filePath, serialized + '\n', 'utf8');
        this.removePendingNode(node.nodeId);
        await this.enforceBoundsAsync();
      })
      .catch((err) => {
        this.removePendingNode(node.nodeId);
        console.error(`[RecoveryTrajectoryLedger] record skipped: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  private async enforceBoundsAsync(): Promise<void> {
    try {
      const stat = await fs.promises.stat(this.filePath);
      if (stat.size <= this.maxFileBytes) {
        await this.enforceNodeCountOnlyAsync();
        await this.pruneSessionIndexFromDisk();
        return;
      }
      await this.rewriteTailAsync();
      await this.pruneSessionIndexFromDisk();
    } catch {
      // best-effort
    }
  }

  private async enforceNodeCountOnlyAsync(): Promise<void> {
    const lines = await safeReadLinesAsync(this.filePath);
    if (lines.length <= this.maxNodes) return;
    await fs.promises.writeFile(this.filePath, lines.slice(-this.maxNodes).join('\n') + '\n', 'utf8');
  }

  private async rewriteTailAsync(): Promise<void> {
    const lines = (await safeReadLinesAsync(this.filePath)).slice(-this.maxNodes);
    const kept: string[] = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const lineBytes = Buffer.byteLength(line + '\n', 'utf8');
      if (bytes + lineBytes > this.maxFileBytes && kept.length > 0) break;
      kept.unshift(line);
      bytes += lineBytes;
    }
    await fs.promises.writeFile(this.filePath, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8');
  }

  private mergePending(nodes: RecoveryTrajectoryNode[]): RecoveryTrajectoryNode[] {
    if (this.pendingNodes.length === 0) return nodes;
    const seen = new Set(nodes.map((node) => node.nodeId));
    return nodes.concat(this.pendingNodes.filter((node) => !seen.has(node.nodeId)));
  }

  private removePendingNode(nodeId: string): void {
    this.pendingNodes = this.pendingNodes.filter((node) => node.nodeId !== nodeId);
  }

  private prunePendingNodes(): void {
    if (this.pendingNodes.length > this.maxNodes) {
      this.pendingNodes = this.pendingNodes.slice(-this.maxNodes);
    }
  }

  private pruneSessionIndex(): void {
    while (this.lastNodeBySession.size > this.maxSessionIndexEntries) {
      const oldestSessionId = this.lastNodeBySession.keys().next().value;
      if (!oldestSessionId) break;
      this.lastNodeBySession.delete(oldestSessionId);
      for (const key of this.lastNodeByContext.keys()) {
        if (key === oldestSessionId || key.startsWith(`${oldestSessionId}\u0000`)) {
          this.lastNodeByContext.delete(key);
        }
      }
    }
  }

  private async pruneSessionIndexFromDisk(): Promise<void> {
    try {
      const nodes = (await safeReadLinesAsync(this.filePath))
        .slice(-this.maxNodes)
        .map((line) => JSON.parse(line) as RecoveryTrajectoryNode);
      const liveSessions = new Set(nodes.map((node) => node.sessionId));
      for (const sessionId of this.lastNodeBySession.keys()) {
        if (!liveSessions.has(sessionId)) this.lastNodeBySession.delete(sessionId);
      }
      for (const [key, node] of this.lastNodeByContext.entries()) {
        if (!liveSessions.has(node.sessionId)) this.lastNodeByContext.delete(key);
      }
      this.pruneSessionIndex();
    } catch {
      this.pruneSessionIndex();
    }
  }
}

export function summarizeArgs(args?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!args) return undefined;
  return sanitizeObject(args, 0) as Record<string, unknown>;
}

export function summarizeResult(result?: Record<string, unknown>): string | undefined {
  if (!result) return undefined;
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => (item && typeof item === 'object' && 'text' in item ? String((item as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
    return summarizeText(text);
  }
  const summary = readString(result._summary) ?? readString(result.summary) ?? readString(result.message);
  return summarizeText(summary);
}

function contextKey(sessionId: string, tabId?: string): string {
  return `${sessionId}\u0000${tabId ?? ''}`;
}

function sanitizeObject(value: unknown, depth: number, key = ''): unknown {
  if (SENSITIVE_KEY_RE.test(key)) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (LARGE_VALUE_KEY_RE.test(key) || value.length > 200) return hashValue(value);
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth >= 2) return `[array:${value.length}]`;
    return value.slice(0, 10).map((item) => sanitizeObject(item, depth + 1, key));
  }
  if (typeof value === 'object') {
    if (depth >= 2) return '[object]';
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 25)) {
      out[childKey] = sanitizeObject(childValue, depth + 1, childKey);
    }
    return out;
  }
  return String(value);
}

function compactObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 8)) {
    if (typeof child === 'string' && child.length > 80) out[key] = hashValue(child);
    else if (typeof child === 'object' && child !== null) out[key] = Array.isArray(child) ? `[array:${child.length}]` : '[object]';
    else out[key] = child;
  }
  return out;
}

function summarizeText(text?: string): string | undefined {
  if (!text) return undefined;
  const compact = text.replace(/\s+/g, ' ').trim();
  return truncate(redactSensitiveText(compact), SUMMARY_MAX_CHARS);
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:set-)?cookie\s*[:=]\s*)[^\n]+/gi, '$1[REDACTED]')
    .replace(/((?:password|secret|token|api[_-]?key|session[_-]?id)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function fingerprint(text: string): string {
  const normalized = text.toLowerCase().replace(/\d+/g, '<n>').replace(/\s+/g, ' ').slice(0, 500);
  return hashValue(normalized);
}

function hashValue(value: string): string {
  return HASHED_PREFIX + crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

async function safeReadLinesAsync(filePath: string): Promise<string[]> {
  try {
    return (await fs.promises.readFile(filePath, 'utf8')).split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}
