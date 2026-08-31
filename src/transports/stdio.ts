/**
 * Stdio transport for MCP server.
 * Reads JSON-RPC messages from stdin (one per line), writes responses to stdout.
 * When stdin closes (EOF), the process exits — this is the expected stdio lifecycle.
 */

import * as readline from 'readline';
import { MCPResponse, MCPErrorCodes } from '../types/mcp';
import { MCPTransport, TransportMessageContext } from './index';
import { shutdownSyncBestEffort } from '../core/process/sync-shutdown';

const STANDALONE_STDOUT_CHUNK_CHARS = 16_384;

interface StdioOutput {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
}

export class StdioTransport implements MCPTransport {
  private rl: readline.Interface | null = null;
  private standaloneBuffer = '';
  private standaloneInput: NodeJS.ReadableStream | null = null;
  private standaloneDataHandler: ((chunk: string | Buffer) => void) | null = null;
  private standaloneMessageQueue: Promise<void> = Promise.resolve();
  private standaloneOutputQueue: Promise<void> = Promise.resolve();
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
    if (process.env.OPENCHROME_STANDALONE_BINARY === '1') {
      void this.enqueueStandaloneResponse(response).catch((error) => {
        console.error(`[StdioTransport] Failed to write standalone response: ${this.errorMessage(error)}`);
      });
      return;
    }
    this.output.write(`${JSON.stringify(response)}\n`);
  }

  start(input: NodeJS.ReadableStream = process.stdin): void {
    if (process.env.OPENCHROME_STANDALONE_BINARY === '1') {
      this.standaloneInput = input;
      this.standaloneDataHandler = (chunk: string | Buffer) => {
        this.standaloneBuffer += chunk.toString();
        let newlineIndex = this.standaloneBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = this.standaloneBuffer.slice(0, newlineIndex).replace(/\r$/, '');
          this.standaloneBuffer = this.standaloneBuffer.slice(newlineIndex + 1);
          if (process.env.OPENCHROME_STANDALONE_DEBUG === '1') {
            console.error(`[StdioTransport] standalone enqueue: ${line.slice(0, 160)}`);
          }
          const handled = this.standaloneMessageQueue.then(() => this.handleLine(line));
          this.standaloneMessageQueue = handled.catch((error) => {
            console.error(`[StdioTransport] Failed to handle standalone message: ${this.errorMessage(error)}`);
          });
          newlineIndex = this.standaloneBuffer.indexOf('\n');
        }
      };
      input.on('data', this.standaloneDataHandler);
    } else {
      const rl = readline.createInterface({
        input,
        // Do NOT set output to process.stdout — stdout is the MCP JSON-RPC channel.
        // Setting it risks protocol corruption if readline writes internally (prompts, echoes).
        terminal: false,
      });
      this.rl = rl;
      rl.on('line', (line) => { void this.handleLine(line); });
      rl.on('close', () => {
        console.error('[StdioTransport] stdin closed (readline), shutting down...');
        try { shutdownSyncBestEffort(); } catch { /* never throw at exit */ }
        process.exit(0);
      });
    }

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
      if (process.env.OPENCHROME_STANDALONE_DEBUG === '1') {
        console.error(`[StdioTransport] standalone handle start: ${String(parsed.method || '(response)')}`);
      }
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
    if (process.env.OPENCHROME_STANDALONE_DEBUG === '1') {
      console.error(`[StdioTransport] standalone handle done: ${String(parsed.method || '(response)')}`);
    }
  }

  private sendHandledResponse(response: MCPResponse): Promise<void> {
    if (process.env.OPENCHROME_STANDALONE_BINARY === '1') {
      return this.enqueueStandaloneResponse(response);
    }
    this.send(response);
    return Promise.resolve();
  }

  private enqueueStandaloneResponse(response: MCPResponse): Promise<void> {
    const line = `${JSON.stringify(response)}\n`;
    const responseId = String(response.id ?? '(notification)');
    const write = this.standaloneOutputQueue.then(async () => {
      if (process.env.OPENCHROME_STANDALONE_DEBUG === '1') {
        console.error(`[StdioTransport] standalone write start: id=${responseId} bytes=${Buffer.byteLength(line)}`);
      }
      for (let offset = 0; offset < line.length; offset += STANDALONE_STDOUT_CHUNK_CHARS) {
        await this.writeChunk(line.slice(offset, offset + STANDALONE_STDOUT_CHUNK_CHARS));
      }
      if (process.env.OPENCHROME_STANDALONE_DEBUG === '1') {
        console.error(`[StdioTransport] standalone write done: id=${responseId}`);
      }
    });
    this.standaloneOutputQueue = write.catch(() => undefined);
    return write;
  }

  private writeChunk(chunk: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.output.write(chunk, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async close(): Promise<void> {
    await this.standaloneMessageQueue.catch(() => undefined);
    await this.standaloneOutputQueue.catch(() => undefined);
    if (this.standaloneInput && this.standaloneDataHandler) {
      this.standaloneInput.removeListener('data', this.standaloneDataHandler);
      this.standaloneInput = null;
      this.standaloneDataHandler = null;
      this.standaloneBuffer = '';
      this.standaloneMessageQueue = Promise.resolve();
      this.standaloneOutputQueue = Promise.resolve();
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}
