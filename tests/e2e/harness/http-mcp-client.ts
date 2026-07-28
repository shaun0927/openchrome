/**
 * HTTP MCP Client for E2E tests.
 * Mirrors the stdio MCPClient but communicates over Streamable HTTP transport.
 * Each instance spawns its own OpenChrome server in HTTP mode.
 */
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { MCPResponse, MCPToolResult } from './mcp-client';
import { hasChildExited, terminateChild } from './child-process';

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 5_000;
const STDERR_CAPTURE_LIMIT = 4_096;

export class HttpMCPClient {
  private serverProcess: ChildProcess | null = null;
  private httpPort: number;
  private metricsPort: number;
  private cdpPort: number;
  private userDataDir: string;
  private baseUrl: string;
  private requestId = 0;
  private sessionId: string | null = null;
  private defaultTimeoutMs: number;
  private extraEnv: Record<string, string>;
  private extraArgs: string[];
  private activeRequests = new Set<http.ClientRequest>();
  private terminalError: Error | null = null;

  constructor(opts?: {
    httpPort?: number;
    metricsPort?: number;
    cdpPort?: number;
    userDataDir?: string;
    env?: Record<string, string>;
    args?: string[];
    timeoutMs?: number;
  }) {
    const slot = Math.floor(Math.random() * 1_000);
    this.httpPort = opts?.httpPort ?? 30_000 + slot;
    this.metricsPort = opts?.metricsPort ?? 32_000 + slot;
    this.cdpPort = opts?.cdpPort ?? 34_000 + slot;
    this.userDataDir = opts?.userDataDir
      ?? path.join(os.tmpdir(), `openchrome-e2e-http-${process.pid}-${this.httpPort}`);
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
      const child = spawn(
        'node',
        [
          serverPath,
          'serve',
          '--http', String(this.httpPort),
          '--http-host', '127.0.0.1',
          '--server-mode',
          '--port', String(this.cdpPort),
          '--user-data-dir', this.userDataDir,
          ...this.extraArgs,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP: '1',
            OPENCHROME_HEALTH_PORT: String(this.metricsPort),
            ...this.extraEnv,
          },
        },
      );
      this.serverProcess = child;
      this.terminalError = null;

      let ready = false;
      let stderrBuf = '';
      let startupSettled = false;
      let startupTimer: NodeJS.Timeout | null = null;

      const clearStartupTimer = () => {
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
      };

      const settleStartup = (error?: Error) => {
        clearStartupTimer();
        if (startupSettled) return;
        startupSettled = true;
        if (!error) {
          resolve();
          return;
        }

        this.terminalError = error;
        this.rejectActiveRequests(error);
        void terminateChild(child)
          .catch((cleanupError: unknown) => {
            const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            error.message = `${error.message}. Cleanup failed: ${detail}`;
          })
          .finally(() => {
            if (this.serverProcess === child) this.serverProcess = null;
            this.sessionId = null;
            reject(error);
          });
      };

      const lifecycleError = (message: string) => {
        const stderr = stderrBuf.trim();
        return new Error(stderr ? `${message}. stderr: ${stderr}` : message);
      };

      const handleTermination = (error: Error) => {
        this.terminalError = error;
        if (this.serverProcess === child) this.serverProcess = null;
        this.sessionId = null;
        this.rejectActiveRequests(error);
        settleStartup(error);
      };

      child.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString();
        stderrBuf = (stderrBuf + msg).slice(-STDERR_CAPTURE_LIMIT);
        if (process.env.DEBUG) process.stderr.write(`[http-mcp-client:${this.httpPort}] ${msg}`);
        // Wait specifically for HTTPTransport to be listening on our port.
        // "[MCPServer] Ready" appears BEFORE the HTTP port is bound, so
        // match the transport's canonical "Listening on host:port" log.
        if (!ready && stderrBuf.includes(`[HTTPTransport] Listening on 127.0.0.1:${this.httpPort}`)) {
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
                settleStartup(new Error(`Initialize failed: ${initResp.error.message}`));
              } else {
                settleStartup();
              }
            })
            .catch((error: unknown) => settleStartup(error instanceof Error ? error : new Error(String(error))));
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
        settleStartup(lifecycleError(`Server startup timeout (${STARTUP_TIMEOUT_MS}ms)`));
      }, STARTUP_TIMEOUT_MS);
      startupTimer.unref();
    });
  }

  /**
   * Stop server and cleanup.
   */
  async stop(): Promise<void> {
    const child = this.serverProcess;
    if (!child) {
      this.rejectActiveRequests(new Error('HTTP client shutdown'));
      return;
    }

    // Try graceful stop
    if (!hasChildExited(child)) {
      try {
        await this.callTool('oc_stop', {}, SHUTDOWN_REQUEST_TIMEOUT_MS).catch(() => { /* ignore */ });
      } catch { /* ignore */ }
    }

    try {
      if (this.serverProcess === child && !hasChildExited(child)) {
        await terminateChild(child);
      }
    } finally {
      if (this.serverProcess === child) this.serverProcess = null;
      this.sessionId = null;
      this.rejectActiveRequests(new Error('HTTP client shutdown'));
    }
  }

  /**
   * Send MCP JSON-RPC request via HTTP POST to /mcp.
   */
  async send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<MCPResponse> {
    if (!this.serverProcess || hasChildExited(this.serverProcess)) {
      throw this.terminalError ?? new Error('HTTP MCP server is not running');
    }
    const id = ++this.requestId;
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise<MCPResponse>((resolve, reject) => {
      let settled = false;
      let req: http.ClientRequest | null = null;
      const settle = (error?: Error, response?: MCPResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (req) this.activeRequests.delete(req);
        if (error) reject(error);
        else resolve(response!);
      };
      const timer = setTimeout(() => {
        const error = new Error(`HTTP request timeout: ${method} (${timeout}ms)`);
        req?.destroy(error);
        settle(error);
      }, timeout);
      timer.unref();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      };
      if (this.sessionId) {
        headers['Mcp-Session-Id'] = this.sessionId;
      }

      req = http.request(
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
            // Capture session ID from response
            const sid = res.headers['mcp-session-id'];
            if (sid && typeof sid === 'string') {
              this.sessionId = sid;
            }

            if (res.statusCode === 202) {
              settle(new Error(`Unexpected HTTP 202 for JSON-RPC request: ${method}`));
              return;
            }

            const responseBody = Buffer.concat(chunks).toString('utf-8');
            try {
              const parsed = JSON.parse(responseBody) as MCPResponse;
              settle(undefined, parsed);
            } catch (err) {
              settle(new Error(`Failed to parse response for ${method}: ${responseBody.slice(0, 200)}`));
            }
          });
        },
      );
      this.activeRequests.add(req);

      req.on('error', (err) => {
        settle(new Error(`HTTP request error for ${method}: ${err.message}`));
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
    return this.serverProcess !== null
      && !this.serverProcess.killed
      && !hasChildExited(this.serverProcess);
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

  private rejectActiveRequests(error: Error): void {
    for (const request of this.activeRequests) request.destroy(error);
    this.activeRequests.clear();
  }

  /**
   * Simple HTTP GET helper.
   */
  private httpGet(port: number, urlPath: string, timeoutMs = 10_000): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let req: http.ClientRequest | null = null;
      const settle = (error?: Error, body?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (req) this.activeRequests.delete(req);
        if (error) reject(error);
        else resolve(body ?? '');
      };
      const timer = setTimeout(() => {
        const error = new Error(`GET ${urlPath} timeout (${timeoutMs}ms)`);
        req?.destroy(error);
        settle(error);
      }, timeoutMs);
      timer.unref();

      req = http.request(
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
            settle(undefined, Buffer.concat(chunks).toString('utf-8'));
          });
        },
      );
      this.activeRequests.add(req);

      req.on('error', (err) => {
        settle(err);
      });
      req.end();
    });
  }
}
