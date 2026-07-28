/**
 * MCP JSON-RPC Client for E2E tests.
 * Extracted from compression-e2e.ts and enhanced with restart support.
 */
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { hasChildExited, terminateChild } from './child-process';

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 5_000;
const STDERR_CAPTURE_LIMIT = 4_096;

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

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private canSend(child: ChildProcess | null): child is ChildProcess {
    return child !== null
      && !child.killed
      && !hasChildExited(child)
      && child.stdin !== null
      && !child.stdin.destroyed
      && !child.stdin.writableEnded;
  }

  private getServeArgs(serverPath: string): string[] {
    const configuredArgs = this.extraEnv.OPENCHROME_E2E_SERVER_ARGS
      ?? process.env.OPENCHROME_E2E_SERVER_ARGS
      ?? '';
    const harnessArgs = configuredArgs.trim() ? configuredArgs.trim().split(/\s+/) : [];
    return [serverPath, 'serve', '--auto-launch', ...harnessArgs, ...this.extraArgs];
  }

  async start(): Promise<void> {
    const serverPath = path.join(process.cwd(), 'dist', 'index.js');
    if (!fs.existsSync(serverPath)) {
      throw new Error(`MCP server not built. Run: npm run build\n  Expected: ${serverPath}`);
    }

    return new Promise((resolve, reject) => {
      const child = spawn('node', this.getServeArgs(serverPath), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.extraEnv },
      });
      this.process = child;

      let ready = false;
      let startupSettled = false;
      let stderrBuffer = '';
      let startupTimer: NodeJS.Timeout | null = null;

      const clearStartupTimer = () => {
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
      };

      const rejectStartup = (error: Error) => {
        clearStartupTimer();
        if (startupSettled) return;
        startupSettled = true;
        this.rejectPending(error);
        void terminateChild(child)
          .catch((cleanupError: unknown) => {
            const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            error.message = `${error.message}. Cleanup failed: ${detail}`;
          })
          .finally(() => {
            if (this.process === child) {
              this.process = null;
              this.buffer = '';
            }
            reject(error);
          });
      };

      const resolveStartup = () => {
        clearStartupTimer();
        if (!startupSettled) {
          startupSettled = true;
          resolve();
        }
      };

      const captureStderr = (msg: string) => {
        stderrBuffer = (stderrBuffer + msg).slice(-STDERR_CAPTURE_LIMIT);
      };

      const lifecycleError = (message: string) => {
        const stderr = stderrBuffer.trim();
        return new Error(stderr ? `${message}. stderr: ${stderr}` : message);
      };

      const handleTermination = (error: Error) => {
        if (this.process === child) {
          this.process = null;
          this.buffer = '';
          this.rejectPending(error);
        }
        rejectStartup(error);
      };

      child.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString();
        captureStderr(msg);
        if (process.env.DEBUG) process.stderr.write(`[mcp-client] ${msg}`);
        if (!ready && (msg.includes('Ready') || msg.includes('MCP server') || msg.includes('waiting'))) {
          ready = true;
          clearStartupTimer();
          this.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'e2e-harness', version: '1.0.0' },
          })
            .then((response) => {
              if (response.error) {
                rejectStartup(new Error(`Initialize failed: ${response.error.message}`));
              } else {
                resolveStartup();
              }
            })
            .catch(rejectStartup);
        }
      });

      child.stdout?.on('data', (data: Buffer) => {
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

      child.on('error', (err) => {
        handleTermination(lifecycleError(`Server process error: ${err.message}`));
      });
      child.on('exit', (code, signal) => {
        const detail = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`;
        handleTermination(lifecycleError(`Server exited with ${detail}${ready ? '' : ' before ready'}`));
      });

      startupTimer = setTimeout(() => {
        rejectStartup(lifecycleError(`Server startup timeout (${STARTUP_TIMEOUT_MS}ms)`));
      }, STARTUP_TIMEOUT_MS);
      startupTimer.unref();
    });
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) {
      this.rejectPending(new Error('Client shutdown'));
      return;
    }

    if (this.canSend(child)) {
      try { await this.callTool('oc_stop', {}, SHUTDOWN_REQUEST_TIMEOUT_MS); } catch { /* ignore */ }
    }

    try {
      if (this.process === child && !hasChildExited(child)) {
        child.stdin?.end();
        await terminateChild(child);
      }
    } finally {
      if (this.process === child) {
        this.process = null;
        this.buffer = '';
      }
      this.rejectPending(new Error('Client shutdown'));
    }
  }

  /**
   * Kill and relaunch the MCP server.
   * Used for E2E-8 compaction resume testing.
   */
  async restart(): Promise<void> {
    const child = this.process;
    this.buffer = '';
    this.rejectPending(new Error('Restart'));

    if (child) {
      await terminateChild(child, { initialSignal: 'SIGKILL' });
      if (this.process === child) this.process = null;
    }

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
    const child = this.process;
    if (!this.canSend(child)) return Promise.reject(new Error('MCP client is not running'));
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
      try {
        child.stdin!.write(
          JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
          (error) => {
            if (!error) return;
            const pending = this.pending.get(id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(id);
            pending.reject(error);
          },
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed && !hasChildExited(this.process);
  }
}
