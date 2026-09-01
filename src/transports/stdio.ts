/**
 * Stdio transport for MCP server.
 * Reads JSON-RPC messages from stdin (one per line), writes responses to stdout.
 * When stdin closes (EOF), the process exits — this is the expected stdio lifecycle.
 */

import * as readline from 'readline';
import { MCPResponse, MCPErrorCodes } from '../types/mcp';
import { MCPTransport, TransportMessageContext } from './index';
import { shutdownSyncBestEffort } from '../core/process/sync-shutdown';

interface StdioOutput {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
}

export class StdioTransport implements MCPTransport {
  private rl: readline.Interface | null = null;
  private messageHandler:
    | ((msg: Record<string, unknown>, signal?: AbortSignal, context?: TransportMessageContext) => Promise<MCPResponse | null>)
    | null = null;

  constructor(private readonly output: StdioOutput = process.stdout) {}

  onMessage(
    handler: (msg: Record<string, unknown>, signal?: AbortSignal, context?: TransportMessageContext) => Promise<MCPResponse | null>,
  ): void {
    this.messageHandler = handler;
  }

  send(response: MCPResponse): void {
    // stdout is the MCP JSON-RPC channel in stdio mode
    this.output.write(`${JSON.stringify(response)}\n`);
  }

  start(input: NodeJS.ReadableStream = process.stdin): void {
    const rl = readline.createInterface({
      input,
      // Do NOT set output to process.stdout; stdout is the MCP JSON-RPC channel.
      terminal: false,
    });
    this.rl = rl;
    rl.on('line', (line) => { void this.handleLine(line); });
    rl.on('close', () => {
      console.error('[StdioTransport] stdin closed (readline), shutting down...');
      try { shutdownSyncBestEffort(); } catch { /* never throw at exit */ }
      process.exit(0);
    });

    // Belt-and-suspenders: monitor stdin directly for EOF/error.
    // When a parent process dies without cleanly closing the pipe,
    // readline may not fire 'close'. Listening on the raw stream
    // catches these edge cases.
    input.on('end', () => {
      console.error('[StdioTransport] stdin ended, shutting down...');
      try { shutdownSyncBestEffort(); } catch { /* never throw at exit */ }
      process.exit(0);
    });
    input.on('error', () => {
      console.error('[StdioTransport] stdin error, shutting down...');
      try { shutdownSyncBestEffort(); } catch { /* never throw at exit */ }
      process.exit(0);
    });
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      const errorResponse: MCPResponse = {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: MCPErrorCodes.PARSE_ERROR,
          message: error instanceof Error ? error.message : 'Parse error',
        },
      };
      await this.sendHandledResponse(errorResponse);
      return;
    }

    if (!this.messageHandler) {
      console.error('[StdioTransport] No message handler registered, dropping message');
      return;
    }

    let response: MCPResponse | null;
    try {
      response = await this.messageHandler(parsed);
    } catch (error) {
      const id = (parsed.id as string | number) ?? 0;
      response = {
        jsonrpc: '2.0',
        id,
        error: {
          code: MCPErrorCodes.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      };
    }

    if (response) {
      await this.sendHandledResponse(response);
    }
  }

  private async sendHandledResponse(response: MCPResponse): Promise<void> {
    this.send(response);
    await Promise.resolve();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async close(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}
