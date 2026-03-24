/**
 * MCP JSON-RPC Client for E2E tests.
 * Extracted from compression-e2e.ts and enhanced with restart support.
 */
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface MCPToolResult {
  text: string;
  raw: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
}

export class MCPClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, {
    resolve: (v: MCPResponse) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private buffer = '';
  private defaultTimeoutMs: number;
  private extraEnv: Record<string, string>;
  private extraArgs: string[];

  constructor(opts?: { timeoutMs?: number; env?: Record<string, string>; args?: string[] }) {
    this.defaultTimeoutMs = opts?.timeoutMs ?? 30_000;
    this.extraEnv = opts?.env ?? {};
    this.extraArgs = opts?.args ?? [];
  }

  async start(): Promise<void> {
    const serverPath = path.join(process.cwd(), 'dist', 'index.js');
    if (!fs.existsSync(serverPath)) {
      throw new Error(`MCP server not built. Run: npm run build\n  Expected: ${serverPath}`);
    }

    return new Promise((resolve, reject) => {
      this.process = spawn('node', [serverPath, 'serve', '--auto-launch', ...this.extraArgs], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.extraEnv },
      });

      let ready = false;

      this.process.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString();
        if (process.env.DEBUG) process.stderr.write(`[mcp-client] ${msg}`);
        if (!ready && (msg.includes('Ready') || msg.includes('MCP server') || msg.includes('waiting'))) {
          ready = true;
          this.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'e2e-harness', version: '1.0.0' },
          })
            .then(() => resolve())
            .catch(reject);
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
            const p = this.pending.get(response.id);
            if (p) {
              clearTimeout(p.timer);
              this.pending.delete(response.id);
              p.resolve(response);
            }
          } catch { /* ignore non-JSON */ }
        }
      });

      this.process.on('error', (err) => { if (!ready) reject(err); });
      this.process.on('exit', (code) => { if (!ready) reject(new Error(`Server exited: ${code}`)); });

      const timeout = setTimeout(() => { if (!ready) reject(new Error('Server startup timeout (30s)')); }, 30_000);
      timeout.unref();
    });
  }

  async stop(): Promise<void> {
    try { await this.callTool('oc_stop', {}); } catch { /* ignore */ }
    this.process?.stdin?.end();
    this.process?.kill('SIGTERM');

    // Wait for exit
    if (this.process) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.process?.kill('SIGKILL');
          resolve();
        }, 5000);
        timer.unref();
        this.process?.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    this.process = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Client shutdown'));
    }
    this.pending.clear();
  }

  /**
   * Kill and relaunch the MCP server.
   * Used for E2E-8 compaction resume testing.
   */
  async restart(): Promise<void> {
    // Force kill
    this.process?.kill('SIGKILL');
    this.process = null;
    this.buffer = '';
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Restart'));
    }
    this.pending.clear();

    // Small delay before restart
    await new Promise((r) => setTimeout(r, 1000));

    // Relaunch
    await this.start();
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<MCPToolResult> {
    const response = await this.send('tools/call', { name, arguments: args }, timeoutMs);
    if (response.error) {
      throw new Error(`Tool '${name}' error: ${response.error.message}`);
    }
    const result = response.result || {};
    const content = (result.content as Array<{ type: string; text?: string }>) || [];
    const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
    return { text, raw: result, content };
  }

  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<MCPResponse> {
    if (!this.process?.stdin) throw new Error('MCP client not started');
    const id = ++this.requestId;
    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: ${method} (${timeout}ms)`));
        }
      }, timeout);
      timer.unref();

      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
