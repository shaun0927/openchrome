/**
 * Degraded stdio MCP responder for the duplicate-controller case (#1474).
 *
 * When `--auto-launch` refuses to start because another session already owns
 * Chrome for this (port, userDataDir), the old behaviour was
 * `console.error(remediation); process.exit(2)` — but the process exited
 * *before* the MCP handshake, so the host discarded stderr and the user saw
 * only a bare `-32000`. The rich, actionable diagnostic never reached them.
 *
 * Instead of exiting, this minimal responder completes the `initialize`
 * handshake (so the host accepts the connection) and then surfaces the
 * remediation through portable MCP surfaces:
 *   - a `notifications/message` (logging) emitted right after initialize;
 *   - a single diagnostic tool whose name/description state the conflict;
 *   - a structured JSON-RPC error (with `data`) on every other request.
 *
 * It owns no Chrome and holds no controller lock — it is a read-only
 * explainer that lets the host render "another session owns Chrome; here is
 * how to fix it" rather than `-32000`. SSOT #1359 P1: portable MCP, robust
 * errors a host LLM can act on.
 */

import * as readline from 'readline';
import { getVersion } from '../version';
import { MCPErrorCodes, type MCPResponse } from '../types/mcp';
import type { DuplicateControllerError } from '../utils/controller-lock';

/** Server-defined JSON-RPC error code surfaced for the conflict. */
export const DUPLICATE_CONTROLLER_ERROR_CODE = -32000;

const DIAGNOSTIC_TOOL_NAME = 'openchrome_owner_conflict';

export interface DuplicateControllerErrorServerOptions {
  /** Override stdout writer (tests). */
  write?: (chunk: string) => void;
  /** Override the protocol version echoed in initialize (tests/compat). */
  protocolVersion?: string;
  /** Override process exit (tests). */
  exit?: (code: number) => void;
  /**
   * If no `initialize` arrives within this window, exit(2) instead of hanging.
   * Guards a non-MCP stdin that stays open but never speaks (e.g.
   * `tail -f /dev/null | serve`). 0 disables. Default 10s.
   */
  initTimeoutMs?: number;
}

function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: number | string | null;
  method?: unknown;
  params?: unknown;
};

export class DuplicateControllerErrorServer {
  private readonly error: DuplicateControllerError;
  private readonly writeOut: (chunk: string) => void;
  private readonly protocolVersion: string;
  private readonly exit: (code: number) => void;
  private readonly initTimeoutMs: number;
  /** Whether a real MCP client completed `initialize` before stdin closed. */
  private sawInitialize = false;

  constructor(error: DuplicateControllerError, options: DuplicateControllerErrorServerOptions = {}) {
    this.error = error;
    this.writeOut = options.write ?? ((chunk) => { process.stdout.write(chunk); });
    this.protocolVersion = options.protocolVersion ?? '2024-11-05';
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.initTimeoutMs = options.initTimeoutMs
      ?? parseEnvInt(process.env.OPENCHROME_DUPLICATE_RESPONDER_INIT_TIMEOUT_MS, 10_000);
  }

  start(input: NodeJS.ReadableStream = process.stdin): void {
    const rl = readline.createInterface({ input, terminal: false });

    // A non-MCP stdin that stays open but never sends `initialize` (e.g.
    // `tail -f /dev/null | serve`) would otherwise hang forever and never
    // report the duplicate-controller refusal. Bound the wait: if no handshake
    // arrives in time, exit(2). Unref'd so a real MCP client is unaffected.
    let initTimer: NodeJS.Timeout | null = null;
    if (this.initTimeoutMs > 0) {
      initTimer = setTimeout(() => {
        if (!this.sawInitialize) this.exit(2);
      }, this.initTimeoutMs);
      initTimer.unref?.();
    }
    const clearInitTimer = () => {
      if (initTimer) { clearTimeout(initTimer); initTimer = null; }
    };

    rl.on('line', (line) => {
      for (const out of this.handleLine(line)) this.writeOut(out);
      if (this.sawInitialize) clearInitTimer();
    });
    rl.on('close', () => {
      clearInitTimer();
      this.exit(this.closeExitCode());
    });
  }

  /**
   * Exit code to use when stdin closes. If a real MCP client handshook
   * (`initialize` seen), the remediation was delivered and a clean disconnect
   * is success (0). But a non-interactive launch with stdin already EOF — e.g.
   * `serve --auto-launch </dev/null` from CI/systemd — closes without any
   * handshake; that is still a refusal-to-start and MUST report failure (2),
   * not a silent success (Codex P2, #1474).
   */
  closeExitCode(): number {
    return this.sawInitialize ? 0 : 2;
  }

  /** Structured remediation payload reused for both the error and the tool. */
  remediationData(): Record<string, unknown> {
    const owner = this.error.owner;
    return {
      reason: 'duplicate_controller',
      port: owner.port,
      userDataDir: owner.userDataDir,
      ownerPid: owner.pid,
      ownerVersion: owner.version,
      ownerCommand: owner.command,
      lockPath: this.error.lockPath,
      remediations: [
        'Stop the existing OpenChrome MCP owner, then reconnect this session.',
        'Or run one shared broker — `openchrome serve --broker --auto-launch ' +
          `--port ${owner.port} --user-data-dir ${owner.userDataDir}` +
          '` — and point every session at it with `serve --connect-broker`.',
        'Or give this session a distinct --port and --user-data-dir.',
      ],
    };
  }

  private summaryMessage(): string {
    const owner = this.error.owner;
    return (
      `OpenChrome is unavailable: another session (pid ${owner.pid}) already owns ` +
      `Chrome on port ${owner.port} for profile ${owner.userDataDir}. ` +
      'Use --connect-broker to share it, or a distinct --port/--user-data-dir.'
    );
  }

  /** Pure line handler — returns serialized JSON-RPC frames to write. */
  handleLine(line: string): string[] {
    if (!line.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      return [serialize({
        jsonrpc: '2.0',
        id: null,
        error: { code: MCPErrorCodes.PARSE_ERROR, message: err instanceof Error ? err.message : 'Parse error' },
      })];
    }

    // JSON-RPC §6 batch: respond with an array of the per-request responses;
    // request members that are notifications produce no response member. We
    // also surface any server-originated notification (the logging frame from
    // initialize) as its own line outside the batch array.
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return [serialize({
          jsonrpc: '2.0',
          id: null,
          error: { code: MCPErrorCodes.INVALID_REQUEST, message: 'Invalid empty batch' },
        })];
      }
      const responses: Array<MCPResponse | Record<string, unknown>> = [];
      const serverNotifications: string[] = [];
      for (const item of parsed) {
        for (const frame of this.handle(item)) {
          if ('id' in frame) responses.push(frame);
          else serverNotifications.push(serialize(frame)); // server notification → own line
        }
      }
      const out: string[] = [];
      if (responses.length > 0) out.push(JSON.stringify(responses) + '\n');
      return out.concat(serverNotifications);
    }

    return this.handle(parsed).map(serialize);
  }

  private handle(raw: unknown): Array<MCPResponse | Record<string, unknown>> {
    // Valid JSON that is not a JSON-RPC object (null, number, string, boolean,
    // or a nested array inside a batch) must yield an Invalid Request error —
    // not a TypeError from `'id' in raw`, which would crash the process and
    // drop the connection the responder exists to preserve.
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return [{
        jsonrpc: '2.0',
        id: null,
        error: { code: MCPErrorCodes.INVALID_REQUEST, message: 'Invalid Request: expected a JSON-RPC object' },
      }];
    }
    const message = raw as JsonRpcMessage;
    const method = typeof message.method === 'string' ? message.method : '';
    // JSON-RPC §4.1: a notification is a request WITHOUT an `id` member. An
    // explicit `id: null` is an unusual-but-valid request, so key off member
    // presence rather than null-ness (a null-check would drop the reply).
    const hasId = 'id' in message;
    const id = (message.id ?? null) as number | string | null;

    // Notifications (no id member) get no reply — JSON-RPC §4.1.
    if (!hasId) return [];

    if (method === 'initialize') {
      this.sawInitialize = true;
      return [
        {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: this.protocolVersion,
            capabilities: { tools: { listChanged: false }, logging: {} },
            serverInfo: { name: 'openchrome', version: getVersion() },
          },
        },
        // Push the remediation as a logging notification so hosts that surface
        // server logs show it immediately, before any tool call.
        {
          jsonrpc: '2.0',
          method: 'notifications/message',
          // MCP logging `data` is a structured, JSON-serializable value (the
          // real server uses an object too), not a bare string.
          params: {
            level: 'error',
            logger: 'openchrome',
            data: { message: this.summaryMessage(), remediation: this.remediationData() },
          },
        },
      ];
    }

    // MCP/JSON-RPC keepalive: a host that pings during or after initialize must
    // get `{ result: {} }`. Returning the generic error here would make many
    // hosts treat the connection as failed and disconnect before the user ever
    // sees the remediation.
    if (method === 'ping') {
      return [{ jsonrpc: '2.0', id, result: {} }];
    }

    if (method === 'tools/list') {
      return [{
        jsonrpc: '2.0',
        id,
        result: {
          tools: [{
            name: DIAGNOSTIC_TOOL_NAME,
            description: this.summaryMessage(),
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          }],
        },
      }];
    }

    if (method === 'tools/call') {
      // Return the remediation as a tool error (isError content), the standard
      // shape a host renders for a failed tool.
      return [{
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: this.summaryMessage() }],
          structuredContent: this.remediationData(),
        },
      }];
    }

    // Any other request: structured JSON-RPC error carrying the remediation.
    return [{
      jsonrpc: '2.0',
      id,
      error: {
        code: DUPLICATE_CONTROLLER_ERROR_CODE,
        message: this.summaryMessage(),
        data: this.remediationData(),
      },
    }];
  }
}

function serialize(frame: MCPResponse | Record<string, unknown>): string {
  return JSON.stringify(frame) + '\n';
}
