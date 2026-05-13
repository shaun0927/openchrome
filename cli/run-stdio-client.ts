import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

interface ToolListResult {
  tools?: Array<{ name?: unknown }>;
}

export class StdioRunClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private rl: readline.Interface | null = null;
  private pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private stderr: string[] = [];
  private httpUrl: string | null = null;
  private httpSessionId: string | null = null;

  async connect(reuse: boolean): Promise<void> {
    if (reuse) {
      await this.connectHttpDaemon();
      return;
    }

    const serveEntry = path.join(__dirname, '..', 'index.js');
    this.child = spawn(process.execPath, [serveEntry, 'serve', '--server-mode'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENCHROME_PPID_WATCH: '0' },
    });
    if (!this.child.stdin || !this.child.stdout) {
      throw new TransportError('Failed to open stdio pipes to child server');
    }
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr.push(chunk.toString());
    });
    this.child.on('error', (err) => this.rejectAll(new TransportError(`Server process error: ${err.message}`)));
    this.child.on('exit', (code, signal) => {
      if (this.pending.size > 0) {
        const suffix = signal ? `signal ${signal}` : `code ${code}`;
        this.rejectAll(new TransportError(`Server process exited before response (${suffix}). ${this.stderrTail()}`));
      }
    });
    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.handleLine(line));

    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'oc-run', version: '1.0.0' },
    });
    this.sendNotification('notifications/initialized');
  }

  async listTools(): Promise<Set<string>> {
    const result = await this.sendRequest('tools/list', {});
    const tools = (result as ToolListResult).tools ?? [];
    return new Set(tools.map((tool) => tool.name).filter((name): name is string => typeof name === 'string'));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.sendRequest('tools/call', { name, arguments: args });
    return result as McpToolCallResult;
  }

  async close(): Promise<void> {
    if (this.httpUrl && this.httpSessionId) {
      const headers = this.httpHeaders();
      headers['Mcp-Session-Id'] = this.httpSessionId;
      await fetch(this.httpUrl, { method: 'DELETE', headers }).catch(() => undefined);
      this.httpUrl = null;
      this.httpSessionId = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    if (!child.killed) {
      child.kill('SIGTERM');
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        resolve();
      }, 1000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (this.httpUrl) return this.sendHttpRequest(method, params);
    if (!this.child?.stdin) throw new TransportError('Server is not connected');
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin!.write(`${payload}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new TransportError(`Failed to write request: ${err.message}`));
        }
      });
    });
    if (response.error) {
      throw new TransportError(`JSON-RPC ${method} failed: ${response.error.message}`);
    }
    return response.result;
  }

  private sendNotification(method: string, params?: unknown): void {
    if (this.httpUrl) {
      void this.sendHttpNotification(method, params);
      return;
    }
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }


  private async connectHttpDaemon(): Promise<void> {
    const host = process.env.OPENCHROME_HTTP_HOST || '127.0.0.1';
    const port = process.env.OPENCHROME_HTTP_PORT || '3100';
    this.httpUrl = `http://${host}:${port}/mcp`;
    try {
      await this.sendHttpRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'oc-run', version: '1.0.0' },
      });
      await this.sendHttpNotification('notifications/initialized');
    } catch (err) {
      this.httpUrl = null;
      throw new TransportError(`Unable to reuse HTTP daemon at http://${host}:${port}/mcp: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async sendHttpRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.httpUrl) throw new TransportError('HTTP daemon is not connected');
    const id = this.nextId++;
    const headers = this.httpHeaders();
    if (this.httpSessionId) headers['Mcp-Session-Id'] = this.httpSessionId;
    const res = await fetch(this.httpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!res.ok) {
      throw new TransportError(`HTTP ${res.status}: ${await res.text()}`);
    }
    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) this.httpSessionId = sessionId;
    const response = await res.json() as JsonRpcResponse;
    if (response.error) {
      throw new TransportError(`JSON-RPC ${method} failed: ${response.error.message}`);
    }
    return response.result;
  }

  private async sendHttpNotification(method: string, params?: unknown): Promise<void> {
    if (!this.httpUrl) return;
    const headers = this.httpHeaders();
    if (this.httpSessionId) headers['Mcp-Session-Id'] = this.httpSessionId;
    await fetch(this.httpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => undefined);
  }

  private httpHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = process.env.OPENCHROME_AUTH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof parsed.id !== 'number') return;
    const waiter = this.pending.get(parsed.id);
    if (!waiter) return;
    this.pending.delete(parsed.id);
    waiter.resolve(parsed);
  }

  private rejectAll(err: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }

  private stderrTail(): string {
    return this.stderr.join('').split('\n').slice(-8).join('\n');
  }
}
