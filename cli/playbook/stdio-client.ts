/**
 * Minimal MCP stdio client for the playbook runner.
 *
 * Spawns `openchrome serve` (or connects to an existing daemon via --reuse)
 * and sends JSON-RPC 2.0 `tools/call` requests, returning the parsed result.
 *
 * This is a self-contained ~100-LOC client. When #843 (oc run) lands, the
 * shared stdio transport can be extracted here and this file becomes a
 * thin wrapper.
 *
 * Transport: newline-delimited JSON over stdin/stdout of the child process
 * (or the reuse socket, which is not yet wired — see TODO below).
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface CallResult {
  success: boolean;
  result: unknown;
  /** For assert steps: 'pass' | 'fail' | 'inconclusive' */
  verdict?: string;
}

export class StdioMcpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();
  private rl: readline.Interface | null = null;
  private initialized = false;
  private stderr: string[] = [];

  async connect(reuse: boolean): Promise<void> {
    if (reuse) {
      // TODO: connect to existing daemon socket when #843 transport lands.
      // For now, fall through to one-shot spawn with a warning.
      console.error('[playbook] --reuse not yet wired to daemon socket; spawning one-shot server.');
    }

    // Resolve the serve entry — from dist/cli/playbook/ go up three levels to root.
    const serveEntry = path.join(__dirname, '..', '..', '..', 'dist', 'index.js');

    this.child = spawn(process.execPath, [serveEntry, 'serve', '--server-mode'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!this.child.stdout || !this.child.stdin) {
      throw new TransportError('Failed to open stdio pipes to child process');
    }

    // Capture stderr for diagnostics
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr.push(chunk.toString());
    });

    this.child.on('error', (err) => {
      this.rejectAll(new TransportError(`Server process error: ${err.message}`));
    });

    this.child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        this.rejectAll(new TransportError(`Server process exited with code ${code}`));
      }
    });

    // Wire up JSON-RPC response reader
    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(trimmed) as JsonRpcResponse;
      } catch {
        // Not JSON — ignore (server may emit non-JSON startup lines)
        return;
      }
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        pending.resolve(msg);
      }
    });

    // MCP initialization handshake
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'oc-playbook', version: '1.0.0' },
    });

    await this.sendRequest('notifications/initialized', undefined);
    this.initialized = true;
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<CallResult> {
    if (!this.initialized) {
      throw new TransportError('Client not initialized. Call connect() first.');
    }

    const response = await this.sendRequest('tools/call', {
      name: tool,
      arguments: args,
    });

    if (response.error) {
      return { success: false, result: response.error };
    }

    const rawResult = response.result as McpToolCallResult | undefined;

    // Parse text content for verdict (assert steps)
    let verdict: string | undefined;
    let parsedContent: unknown = rawResult;

    if (rawResult?.content) {
      const textBlock = rawResult.content.find((c) => c.type === 'text' && c.text);
      if (textBlock?.text) {
        try {
          parsedContent = JSON.parse(textBlock.text);
          const pc = parsedContent as Record<string, unknown>;
          if (typeof pc['verdict'] === 'string') {
            verdict = pc['verdict'] as string;
          }
        } catch {
          parsedContent = textBlock.text;
        }
      }
    }

    const success = rawResult?.isError !== true && (verdict === undefined || verdict === 'pass');

    return { success, result: parsedContent, verdict };
  }

  async disconnect(): Promise<void> {
    this.rl?.close();
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.child?.kill('SIGKILL');
          resolve();
        }, 3000);
        this.child?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    this.pendingRequests.clear();
  }

  private async sendRequest(method: string, params: unknown): Promise<JsonRpcResponse> {
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const id = this.nextId++;
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method };
      if (params !== undefined) {
        req.params = params;
      }

      this.pendingRequests.set(id, { resolve, reject });

      const line = JSON.stringify(req) + '\n';
      this.child?.stdin?.write(line, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(new TransportError(`Write error: ${err.message}`));
        }
      });

      // Timeout after 30s per request
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new TransportError(`Timeout waiting for response to "${method}" (id=${id})`));
        }
      }, 30000);
    });
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  getStderr(): string {
    return this.stderr.join('');
  }
}
