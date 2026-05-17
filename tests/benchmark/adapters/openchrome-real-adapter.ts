/**
 * Real MCP Adapter - Connects to actual OpenChrome MCP server process
 *
 * Spawns an MCP server subprocess and communicates via JSON-RPC over stdio.
 * Used for real performance benchmarking (as opposed to stub adapter for CI).
 *
 * Usage:
 *   const adapter = new OpenChromeRealAdapter({ mode: 'dom' });
 *   await adapter.setup();    // Spawns MCP server
 *   await adapter.callTool('navigate', { url: '...' });
 *   await adapter.teardown(); // Kills MCP server
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { MCPAdapter, MCPToolResult } from '../benchmark-runner';

export interface RealAdapterOptions {
  mode: 'ax' | 'dom';
  /** Path to the MCP server entry point (default: dist/index.js) */
  serverPath?: string;
  /** Timeout for individual tool calls in ms (default: 30000) */
  callTimeoutMs?: number;
  /** Timeout for server startup in ms (default: 15000) */
  startupTimeoutMs?: number;
  /** CDP endpoint whose port should be used by the OpenChrome MCP server. */
  cdpEndpoint?: string;
  /** Explicit Chrome debugging port for OpenChrome MCP serve. */
  chromePort?: string;
}

interface MCPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: {
    content?: Array<{ type: string; text?: string; data?: string }>;
    isError?: boolean;
    _timing?: { durationMs: number; startTime: number; endTime: number };
  };
  error?: { code: number; message: string };
}

export function chromePortFromCdpEndpoint(cdpEndpoint: string | undefined): string | undefined {
  if (!cdpEndpoint) return undefined;
  try {
    return String(new URL(cdpEndpoint).port || 9222);
  } catch {
    return undefined;
  }
}

export function openChromeServeEnvForCdpEndpoint(cdpEndpoint: string | undefined, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const chromePort = chromePortFromCdpEndpoint(cdpEndpoint);
  return chromePort ? { ...baseEnv, CHROME_PORT: chromePort } : baseEnv;
}

export class OpenChromeRealAdapter implements MCPAdapter {
  name = 'OpenChrome';
  mode: string;

  private options: Required<Omit<RealAdapterOptions, 'cdpEndpoint' | 'chromePort'>> & Pick<RealAdapterOptions, 'cdpEndpoint' | 'chromePort'>;
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending: Map<number, {
    resolve: (value: MCPResponse) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private buffer = '';
  private sessionId = `benchmark-${Date.now()}`;

  constructor(options: RealAdapterOptions) {
    this.mode = options.mode;
    this.options = {
      mode: options.mode,
      serverPath: options.serverPath || path.join(process.cwd(), 'dist', 'index.js'),
      callTimeoutMs: options.callTimeoutMs || 30000,
      startupTimeoutMs: options.startupTimeoutMs || 15000,
      cdpEndpoint: options.cdpEndpoint,
      chromePort: options.chromePort,
    };
  }


  async setup(): Promise<void> {
    return new Promise((resolve, reject) => {
      const chromePort = this.options.chromePort ?? chromePortFromCdpEndpoint(this.options.cdpEndpoint);
      const serveArgs = [this.options.serverPath, 'serve', ...(chromePort ? ['--port', chromePort] : [])];
      this.process = spawn('node', serveArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: openChromeServeEnvForCdpEndpoint(this.options.cdpEndpoint),
      });

      let ready = false;

      this.process.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString();
        if (msg.includes('Ready, waiting for requests') || msg.includes('MCP server')) {
          if (!ready) {
            ready = true;
            // Send initialize handshake
            this.send('initialize', {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'benchmark-runner', version: '1.0.0' },
            })
              .then(() => resolve())
              .catch(reject);
          }
        }
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line) as MCPResponse;
            const pending = this.pending.get(response.id);
            if (pending) {
              this.pending.delete(response.id);
              pending.resolve(response);
            }
          } catch {
            // Ignore non-JSON output
          }
        }
      });

      this.process.on('error', (err) => {
        if (!ready) reject(err);
      });

      this.process.on('exit', (code) => {
        if (!ready) reject(new Error(`MCP server exited with code ${code}`));
      });

      const startupTimer = setTimeout(() => {
        if (!ready) reject(new Error(`MCP server startup timeout (${this.options.startupTimeoutMs}ms)`));
      }, this.options.startupTimeoutMs);
      startupTimer.unref();
    });
  }

  async teardown(): Promise<void> {
    if (this.process) {
      // Try graceful shutdown first
      try {
        await this.callTool('oc_stop', {});
      } catch {
        // Ignore errors during shutdown
      }

      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    // Clear pending requests
    for (const [, pending] of this.pending) {
      pending.reject(new Error('Adapter teardown'));
    }
    this.pending.clear();
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const response = await this.send('tools/call', {
      name: toolName,
      arguments: args,
    });

    if (response.error) {
      throw new Error(`MCP ${toolName} failed: ${response.error.message}`);
    }

    const result = response.result || { content: [] };
    if (result.isError) {
      const message = (result.content || [])
        .map((part) => part.text || part.data || '')
        .filter(Boolean)
        .join('\n')
        .trim();
      throw new Error(`MCP ${toolName} returned an error${message ? `: ${message}` : ''}`);
    }

    const toolResult: MCPToolResult = {
      content: result.content || [],
      isError: result.isError,
    };

    // Attach _timing metadata if present for serverTimingMs extraction
    if (result._timing) {
      (toolResult as MCPToolResult & { _timing?: unknown })._timing = result._timing;
    }

    return toolResult;
  }

  private async send(method: string, params?: Record<string, unknown>): Promise<MCPResponse> {
    if (!this.process?.stdin) {
      throw new Error('MCP process not started');
    }

    const id = ++this.requestId;
    const request: MCPRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(request) + '\n');

      const callTimer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Tool call "${method}" timed out after ${this.options.callTimeoutMs}ms`));
        }
      }, this.options.callTimeoutMs);
      callTimer.unref();
    });
  }
}
