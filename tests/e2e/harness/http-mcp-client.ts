/**
 * HTTP MCP Client for E2E tests.
 * Mirrors the stdio MCPClient but communicates over Streamable HTTP transport.
 * Each instance spawns its own OpenChrome server in HTTP mode.
 */
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { MCPResponse, MCPToolResult } from './mcp-client';

export class HttpMCPClient {
  private serverProcess: ChildProcess | null = null;
  private httpPort: number;
  private metricsPort: number;
  private baseUrl: string;
  private requestId = 0;
  private sessionId: string | null = null;
  private defaultTimeoutMs: number;
  private extraEnv: Record<string, string>;
  private extraArgs: string[];

  constructor(opts?: {
    httpPort?: number;
    metricsPort?: number;
    env?: Record<string, string>;
    args?: string[];
    timeoutMs?: number;
  }) {
    this.httpPort = opts?.httpPort ?? 3200 + Math.floor(Math.random() * 100);
    this.metricsPort = opts?.metricsPort ?? 9200 + Math.floor(Math.random() * 100);
    this.baseUrl = `http://127.0.0.1:${this.httpPort}`;
    this.defaultTimeoutMs = opts?.timeoutMs ?? 30_000;
    this.extraEnv = opts?.env ?? {};
    this.extraArgs = opts?.args ?? [];
  }

  /**
   * Start OpenChrome server in HTTP mode.
   * Waits for the server to emit a ready signal on stderr.
   */
  async start(): Promise<void> {
    const serverPath = path.join(process.cwd(), 'dist', 'index.js');
    if (!fs.existsSync(serverPath)) {
      throw new Error(`MCP server not built. Run: npm run build\n  Expected: ${serverPath}`);
    }

    return new Promise<void>((resolve, reject) => {
      this.serverProcess = spawn(
        'node',
        [
          serverPath,
          'serve',
          '--http', String(this.httpPort),
          '--auto-launch',
          '--server-mode',
          ...this.extraArgs,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            OPENCHROME_HEALTH_PORT: String(this.metricsPort),
            ...this.extraEnv,
          },
        },
      );

      let ready = false;
      let stderrBuf = '';

      this.serverProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString();
        stderrBuf += msg;
        if (process.env.DEBUG) process.stderr.write(`[http-mcp-client:${this.httpPort}] ${msg}`);
        // Wait specifically for HTTPTransport to be listening on our port.
        // "[MCPServer] Ready" appears BEFORE the HTTP port is bound, so
        // we must wait for "[HTTPTransport] Listening on port XXXX".
        if (!ready && stderrBuf.includes(`Listening on port ${this.httpPort}`)) {
          ready = true;
          // Send initialize over HTTP
          this.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'e2e-http-harness', version: '1.0.0' },
          })
            .then((initResp) => {
              // Capture session ID from response header (stored in send())
              if (initResp.error) {
                reject(new Error(`Initialize failed: ${initResp.error.message}`));
              } else {
                resolve();
              }
            })
            .catch(reject);
        }
      });

      this.serverProcess.on('error', (err) => {
        if (!ready) reject(err);
      });

      this.serverProcess.on('exit', (code) => {
        if (!ready) reject(new Error(`Server exited with code ${code} before ready. stderr: ${stderrBuf.slice(-500)}`));
      });

      const timeout = setTimeout(() => {
        if (!ready) reject(new Error(`Server startup timeout (30s). stderr: ${stderrBuf.slice(-500)}`));
      }, 30_000);
      timeout.unref();
    });
  }

  /**
   * Stop server and cleanup.
   */
  async stop(): Promise<void> {
    if (!this.serverProcess) return;

    // Try graceful stop
    try {
      await this.callTool('oc_stop', {}).catch(() => { /* ignore */ });
    } catch { /* ignore */ }

    this.serverProcess.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.serverProcess?.kill('SIGKILL');
        resolve();
      }, 5000);
      timer.unref();
      this.serverProcess?.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.serverProcess = null;
    this.sessionId = null;
  }

  /**
   * Send MCP JSON-RPC request via HTTP POST to /mcp.
   */
  async send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<MCPResponse> {
    const id = ++this.requestId;
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise<MCPResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`HTTP request timeout: ${method} (${timeout}ms)`));
      }, timeout);
      timer.unref();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      };
      if (this.sessionId) {
        headers['Mcp-Session-Id'] = this.sessionId;
      }

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.httpPort,
          path: '/mcp',
          method: 'POST',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            clearTimeout(timer);
            // Capture session ID from response
            const sid = res.headers['mcp-session-id'];
            if (sid && typeof sid === 'string') {
              this.sessionId = sid;
            }

            if (res.statusCode === 202) {
              // Notification accepted — synthesize a response
              resolve({ jsonrpc: '2.0', id, result: {} } as MCPResponse);
              return;
            }

            const responseBody = Buffer.concat(chunks).toString('utf-8');
            try {
              const parsed = JSON.parse(responseBody) as MCPResponse;
              resolve(parsed);
            } catch (err) {
              reject(new Error(`Failed to parse response for ${method}: ${responseBody.slice(0, 200)}`));
            }
          });
        },
      );

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`HTTP request error for ${method}: ${err.message}`));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Call a tool and parse the result.
   */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<MCPToolResult> {
    const response = await this.send('tools/call', { name, arguments: args }, timeoutMs);
    if (response.error) {
      throw new Error(`Tool '${name}' error: ${response.error.message}`);
    }
    const result = response.result || {};
    const content = (result.content as Array<{ type: string; text?: string }>) || [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '';
    const isError = !!(result.isError);
    return { text, raw: result, content, isError } as MCPToolResult & { isError: boolean };
  }

  /**
   * Get health endpoint (on the metrics/health port).
   */
  async getHealth(): Promise<Record<string, unknown>> {
    return this.httpGet(this.metricsPort, '/health').then((body) => JSON.parse(body));
  }

  /**
   * Get MCP transport health (on the HTTP port).
   */
  async getMcpHealth(): Promise<Record<string, unknown>> {
    return this.httpGet(this.httpPort, '/health').then((body) => JSON.parse(body));
  }

  /**
   * Get Prometheus metrics endpoint (raw text).
   */
  async getMetrics(): Promise<string> {
    return this.httpGet(this.metricsPort, '/metrics');
  }

  /**
   * Get the server process PID.
   */
  getPid(): number | null {
    return this.serverProcess?.pid ?? null;
  }

  /**
   * Get Chrome PID by parsing health data or using ps.
   */
  async getChromePid(): Promise<number | null> {
    try {
      const health = await this.getHealth();
      if (health.chrome && typeof (health.chrome as Record<string, unknown>).pid === 'number') {
        return (health.chrome as Record<string, unknown>).pid as number;
      }
    } catch { /* fall through */ }

    // Fallback: try ps to find Chrome child
    const serverPid = this.getPid();
    if (!serverPid) return null;

    return new Promise((resolve) => {
      const ps = spawn('pgrep', ['-P', String(serverPid), '-x', 'chrome']);
      let out = '';
      ps.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      ps.on('close', () => {
        const pid = parseInt(out.trim().split('\n')[0], 10);
        resolve(isNaN(pid) ? null : pid);
      });
    });
  }

  /**
   * Kill Chrome process.
   */
  async killChrome(): Promise<void> {
    const pid = await this.getChromePid();
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch { /* may already be dead */ }
    }
  }

  /**
   * Whether the server process is still running.
   */
  get isRunning(): boolean {
    return this.serverProcess !== null && !this.serverProcess.killed;
  }

  /**
   * The HTTP port this client connects to.
   */
  get port(): number {
    return this.httpPort;
  }

  /**
   * The metrics/health port.
   */
  get healthPort(): number {
    return this.metricsPort;
  }

  /**
   * Simple HTTP GET helper.
   */
  private httpGet(port: number, urlPath: string, timeoutMs = 10_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`GET ${urlPath} timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      timer.unref();

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method: 'GET',
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            clearTimeout(timer);
            resolve(Buffer.concat(chunks).toString('utf-8'));
          });
        },
      );

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.end();
    });
  }
}
