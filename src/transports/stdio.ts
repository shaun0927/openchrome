/**
 * Stdio transport for MCP server.
 * Reads JSON-RPC messages from stdin (one per line), writes responses to stdout.
 * When stdin closes (EOF), the process exits — this is the expected stdio lifecycle.
 */

import * as readline from 'readline';
import { MCPResponse, MCPErrorCodes } from '../types/mcp';
import { MCPTransport } from './index';

export class StdioTransport implements MCPTransport {
  private rl: readline.Interface | null = null;
  private messageHandler: ((msg: Record<string, unknown>) => Promise<MCPResponse | null>) | null = null;

  onMessage(handler: (msg: Record<string, unknown>) => Promise<MCPResponse | null>): void {
    this.messageHandler = handler;
  }

  send(response: MCPResponse): void {
    // stdout is the MCP JSON-RPC channel in stdio mode
    console.log(JSON.stringify(response));
  }

  start(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      // Do NOT set output to process.stdout — stdout is the MCP JSON-RPC channel.
      // Setting it risks protocol corruption if readline writes internally (prompts, echoes).
      terminal: false,
    });

    this.rl.on('line', (line) => {
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
        this.send(errorResponse);
        return;
      }

      if (!this.messageHandler) {
        console.error('[StdioTransport] No message handler registered, dropping message');
        return;
      }

      this.messageHandler(parsed)
        .then((response) => {
          if (response) {
            this.send(response);
          }
        })
        .catch((error) => {
          const id = (parsed.id as string | number) ?? 0;
          const errorResponse: MCPResponse = {
            jsonrpc: '2.0',
            id,
            error: {
              code: MCPErrorCodes.INTERNAL_ERROR,
              message: error instanceof Error ? error.message : 'Internal error',
            },
          };
          this.send(errorResponse);
        });
    });

    this.rl.on('close', () => {
      console.error('[StdioTransport] stdin closed, shutting down...');
      process.exit(0);
    });
  }

  async close(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}
