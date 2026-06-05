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
  /** Whether a real MCP client completed `initialize` before stdin closed. */
  private sawInitialize = false;

  constructor(error: DuplicateControllerError, options: DuplicateControllerErrorServerOptions = {}) {
    this.error = error;
    this.writeOut = options.write ?? ((chunk) => { process.stdout.write(chunk); });
    this.protocolVersion = options.protocolVersion ?? '2024-11-05';
    this.exit = options.exit ?? ((code) => process.exit(code));
  }

  start(): void {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      for (const out of this.handleLine(line)) this.writeOut(out);
    });
    rl.on('close', () => this.exit(this.closeExitCode()));
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
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (err) {
      return [serialize({
        jsonrpc: '2.0',
        id: null,
        error: { code: MCPErrorCodes.PARSE_ERROR, message: err instanceof Error ? err.message : 'Parse error' },
      })];
    }
    return this.handle(message).map(serialize);
  }

  private handle(message: JsonRpcMessage): Array<MCPResponse | Record<string, unknown>> {
    const method = typeof message.method === 'string' ? message.method : '';
    const hasId = message.id !== undefined && message.id !== null;
    const id = (message.id ?? null) as number | string | null;

    // Notifications (no id) get no reply — JSON-RPC §4.1.
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
          params: { level: 'error', logger: 'openchrome', data: this.summaryMessage() },
        },
      ];
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
