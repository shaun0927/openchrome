/**
 * browser-use competitor adapter for the competitive benchmark suite (#1255).
 *
 * browser-use is a Python package, so unlike the other competitor adapters
 * this one drives the library across a process boundary: it spawns the
 * `browser_use_bridge.py` JSON-over-stdio bridge under `tests/benchmark/bridges/`
 * and translates the benchmark's `callTool(toolName, args)` surface into the
 * bridge protocol.
 *
 * Per Epic #1254 fairness principle #6 (and #1255 success criterion): the
 * subprocess + bridge overhead is tracked SEPARATELY from any token / success
 * metric. The adapter exposes `bridgeOverheadMs` as a read-only property on
 * the adapter itself; the per-call result content never has bridge timings
 * mixed in.
 *
 * Tool translation:
 *
 *   tabs_create({ url })   -> bridge.open_tab({ url })   -> { tabId }
 *   read_page({ tabId })   -> bridge.read_page({ tabId }) -> DOM-serialization
 *   tabs_close({ tabId })  -> bridge.close_tab({ tabId })
 *
 * The bridge transport is an injectable interface; the default implementation
 * spawns the Python subprocess. Unit tests inject a mock transport so the
 * translation logic is fully covered without spinning up Python or
 * browser-use itself.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { MCPAdapter, MCPToolResult } from '../benchmark-runner';

/** Wire request shape — must match browser_use_bridge.py. */
interface BridgeRequest {
  id: number;
  method: 'ping' | 'open_tab' | 'read_page' | 'close_tab' | 'shutdown';
  args: Record<string, unknown>;
}

/** Wire response shape — must match browser_use_bridge.py. */
export interface BridgeResponse {
  id: number;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  recvMonotonicNs?: number;
}

/**
 * Low-level bridge transport. The default implementation spawns the Python
 * subprocess; tests inject a mock implementation.
 */
export interface BrowserUseBridgeTransport {
  start(): Promise<void>;
  send(request: BridgeRequest): Promise<BridgeResponse>;
  stop(): Promise<void>;
}

export interface BrowserUseAdapterOptions {
  /** Python interpreter (default: the one in .venv-browser-use, else `python3`). */
  python?: string;
  /** Override path to browser_use_bridge.py. */
  bridgeScriptPath?: string;
  /** Per-request timeout in ms (default 30s). */
  callTimeoutMs?: number;
  /** Bridge startup timeout in ms (default 15s). */
  startupTimeoutMs?: number;
  /**
   * Inject the transport for unit tests. When provided, the default
   * subprocess transport is NOT constructed — keeps the translation logic
   * unit-testable without Python.
   */
  transport?: BrowserUseBridgeTransport;
}

const DEFAULT_PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const DEFAULT_CALL_TIMEOUT_MS = 30000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;

function textResult(text: string): MCPToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): MCPToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function defaultBridgeScriptPath(): string {
  return path.join(__dirname, '..', 'bridges', 'browser_use_bridge.py');
}

/**
 * Default transport: spawn the Python bridge as a subprocess and frame JSON
 * over stdio. Pending requests are rejected on stop() so a stuck call cannot
 * leak.
 */
class SubprocessBrowserUseTransport implements BrowserUseBridgeTransport {
  private process: ChildProcess | null = null;
  private buffer = '';
  private readonly pending = new Map<
    number,
    { resolve: (r: BridgeResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly python: string,
    private readonly scriptPath: string,
    private readonly callTimeoutMs: number,
    private readonly startupTimeoutMs: number,
  ) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.python, [this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let ready = false;

      this.process.stderr?.on('data', (data: Buffer) => {
        if (ready) return;
        if (data.toString().includes('browser-use bridge ready')) {
          ready = true;
          resolve();
        }
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line) as BridgeResponse;
            const slot = this.pending.get(response.id);
            if (slot) {
              clearTimeout(slot.timer);
              this.pending.delete(response.id);
              slot.resolve(response);
            }
          } catch {
            // Defensive: the bridge promises stdout = JSON-only, but ignore
            // any stray line rather than crashing the adapter.
          }
        }
      });

      this.process.on('error', (err) => {
        if (!ready) reject(err);
      });
      this.process.on('exit', (code) => {
        if (!ready) reject(new Error(`browser-use bridge exited with code ${code} before ready`));
      });

      const startupTimer = setTimeout(() => {
        if (!ready) reject(new Error(`browser-use bridge startup timed out after ${this.startupTimeoutMs}ms`));
      }, this.startupTimeoutMs);
      startupTimer.unref();
    });
  }

  async send(request: BridgeRequest): Promise<BridgeResponse> {
    if (!this.process?.stdin) {
      throw new Error('browser-use bridge subprocess not started');
    }
    return new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(request.id)) {
          this.pending.delete(request.id);
          reject(new Error(`browser-use bridge "${request.method}" timed out after ${this.callTimeoutMs}ms`));
        }
      }, this.callTimeoutMs);
      timer.unref();
      this.pending.set(request.id, { resolve, reject, timer });
      this.process!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  async stop(): Promise<void> {
    for (const [, slot] of this.pending) {
      clearTimeout(slot.timer);
      slot.reject(new Error('browser-use bridge stopped'));
    }
    this.pending.clear();
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
  }
}

export class BrowserUseAdapter implements MCPAdapter {
  readonly name = 'browser-use';
  readonly mode = 'dom-serialization';
  readonly kind = 'bridge' as const;

  private readonly python: string;
  private readonly callTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly bridgeScriptPath: string;
  private readonly injectedTransport?: BrowserUseBridgeTransport;

  private transport: BrowserUseBridgeTransport | null = null;
  private requestSeq = 0;
  // Aggregated bridge round-trip time across the adapter's lifetime, exposed
  // SEPARATELY on this adapter so it never contaminates token/success metrics.
  private _bridgeOverheadMs = 0;

  constructor(options: BrowserUseAdapterOptions = {}) {
    this.python = options.python ?? DEFAULT_PYTHON;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.bridgeScriptPath = options.bridgeScriptPath ?? defaultBridgeScriptPath();
    this.injectedTransport = options.transport;
  }

  async setup(): Promise<void> {
    this.transport =
      this.injectedTransport ??
      new SubprocessBrowserUseTransport(
        this.python,
        this.bridgeScriptPath,
        this.callTimeoutMs,
        this.startupTimeoutMs,
      );
    await this.transport.start();
  }

  async teardown(): Promise<void> {
    if (this.transport) {
      try {
        // Best-effort graceful shutdown; ignore failures so teardown is total.
        await this.sendRaw('shutdown', {});
      } catch {
        // ignore
      }
      await this.transport.stop();
      this.transport = null;
    }
    this.requestSeq = 0;
    // Reset overhead so a reused adapter (setup → teardown → setup again, as
    // BenchmarkRunner does per run) does not double-count time from previous
    // runs into the next run's bridgeOverheadMs.
    this._bridgeOverheadMs = 0;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.transport) {
      return errorResult('BrowserUseAdapter: setup() was not called');
    }
    try {
      switch (toolName) {
        case 'tabs_create':
          return await this.createTab(args);
        case 'read_page':
          return await this.readPage(args);
        case 'tabs_close':
          return await this.closeTab(args);
        default:
          return errorResult(`BrowserUseAdapter: unsupported tool "${toolName}"`);
      }
    } catch (err) {
      return errorResult(`BrowserUseAdapter: ${toolName} failed: ${(err as Error).message}`);
    }
  }

  /** Aggregated bridge round-trip across this adapter — kept separate from
   *  any task-level token or success metric (Epic #1254 fairness #6). */
  get bridgeOverheadMs(): number {
    return this._bridgeOverheadMs;
  }

  private async sendRaw(
    method: BridgeRequest['method'],
    args: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const id = ++this.requestSeq;
    const start = Date.now();
    const response = await (this.transport as BrowserUseBridgeTransport).send({
      id,
      method,
      args,
    });
    this._bridgeOverheadMs += Date.now() - start;
    if (!response.ok) {
      throw new Error(response.error ?? 'browser-use bridge returned no error message');
    }
    return response;
  }

  private async createTab(args: Record<string, unknown>): Promise<MCPToolResult> {
    const url = typeof args.url === 'string' ? args.url : '';
    const response = await this.sendRaw('open_tab', { url });
    const tabId = String((response.result || {}).tabId ?? '');
    if (!tabId) {
      return errorResult('BrowserUseAdapter: tabs_create received no tabId from bridge');
    }
    return textResult(JSON.stringify({ tabId }));
  }

  private async readPage(args: Record<string, unknown>): Promise<MCPToolResult> {
    const tabId = typeof args.tabId === 'string' ? args.tabId : '';
    const response = await this.sendRaw('read_page', { tabId });
    const payload = String((response.result || {}).payload ?? '');
    return textResult(payload);
  }

  private async closeTab(args: Record<string, unknown>): Promise<MCPToolResult> {
    const tabId = typeof args.tabId === 'string' ? args.tabId : '';
    await this.sendRaw('close_tab', { tabId });
    return textResult(JSON.stringify({ closed: tabId }));
  }
}
