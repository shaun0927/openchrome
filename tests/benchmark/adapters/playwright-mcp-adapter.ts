/**
 * playwright-mcp competitor adapter for the competitive benchmark suite (#1255).
 *
 * Drives the upstream `@playwright/mcp` server through the same
 * `callTool(toolName, args)` surface every other competitor implements, so
 * benchmark task code stays identical across libraries (Epic #1254,
 * methodology #4). The only thing that differs is the library under the hood.
 *
 * playwright-mcp IS an MCP server, so unlike the raw Playwright adapter this
 * one speaks JSON-RPC to it rather than calling Playwright APIs directly.
 * Translation map (OpenChrome tool names -> playwright-mcp tool names):
 *
 *   tabs_create({ url })   -> first call:  browser_navigate({ url })
 *                          -> later calls: browser_tab_new({ url })
 *                          (returns { tabId } -- a synthetic id the adapter owns)
 *   read_page({ tabId })   -> browser_tab_select({ index }) + browser_snapshot()
 *                          (returns the accessibility snapshot text -- that is
 *                          playwright-mcp's idiomatic "hand this to an LLM"
 *                          payload, equivalent to Playwright's
 *                          accessibility.snapshot() and the right comparison
 *                          baseline for the Token Efficiency axis #1256)
 *   tabs_close({ tabId })  -> browser_tab_close({ index })
 *
 * Default transport spawns the `@playwright/mcp` CLI (resolved via
 * `require.resolve('@playwright/mcp/cli.js')`) and speaks JSON-RPC over
 * stdio, mirroring `OpenChromeRealAdapter`. The transport is injected so the
 * translation logic stays unit-testable without spawning a real MCP server.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { MCPAdapter, MCPToolResult } from '../benchmark-runner';

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
  };
  error?: { code: number; message: string };
}

/**
 * Low-level transport the adapter uses to talk to playwright-mcp. The default
 * implementation spawns a subprocess; tests pass a mock implementation.
 */
export interface PlaywrightMcpTransport {
  start(): Promise<void>;
  callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult>;
  stop(): Promise<void>;
}

export interface PlaywrightMcpAdapterOptions {
  /** CDP endpoint of an already-running Chrome; passed to `playwright-mcp --cdp-endpoint`. */
  cdpEndpoint?: string;
  /** Override the resolved path to `@playwright/mcp/cli.js`. */
  serverPath?: string;
  /** Per-call timeout in ms (default 30s). */
  callTimeoutMs?: number;
  /** Startup timeout in ms (default 15s). */
  startupTimeoutMs?: number;
  /**
   * Inject the transport directly. When provided, the default subprocess
   * transport is NOT constructed — keeps the translation logic unit-testable
   * without spawning a real MCP server.
   */
  transport?: PlaywrightMcpTransport;
}

const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';
const DEFAULT_CALL_TIMEOUT_MS = 30000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;

function textResult(text: string): MCPToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): MCPToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Extract a plain-text payload from an MCPToolResult. playwright-mcp's
 * snapshot tool returns one text content block; this helper joins all
 * text blocks defensively in case a future version returns multiple.
 */
function joinText(result: MCPToolResult): string {
  return (result.content || [])
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .filter((s) => s.length > 0)
    .join('\n');
}

/**
 * Default subprocess transport. Lazy because `require.resolve` against a not-
 * yet-installed dep would throw at module import time and break test
 * discovery.
 */
class SubprocessPlaywrightMcpTransport implements PlaywrightMcpTransport {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private buffer = '';
  private readonly pending = new Map<
    number,
    { resolve: (r: MCPResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly cdpEndpoint: string,
    private readonly serverPath: string,
    private readonly callTimeoutMs: number,
    private readonly startupTimeoutMs: number,
  ) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(
        'node',
        [this.serverPath, '--cdp-endpoint', this.cdpEndpoint],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );

      let ready = false;

      this.process.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line) as MCPResponse;
            const slot = this.pending.get(response.id);
            if (slot) {
              clearTimeout(slot.timer);
              this.pending.delete(response.id);
              slot.resolve(response);
            }
          } catch {
            // playwright-mcp may emit non-JSON banner lines on stdout. Ignore.
          }
        }
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        // playwright-mcp prints "Listening on ..." or similar to stderr.
        if (ready) return;
        const msg = data.toString();
        if (
          msg.includes('Listening') ||
          msg.includes('listening') ||
          msg.includes('ready') ||
          msg.includes('Ready')
        ) {
          ready = true;
          this.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'openchrome-benchmark', version: '1.0.0' },
          })
            .then(() => resolve())
            .catch(reject);
        }
      });

      this.process.on('error', (err) => {
        if (!ready) reject(err);
      });
      this.process.on('exit', (code) => {
        if (!ready) reject(new Error(`playwright-mcp exited with code ${code} before startup`));
      });

      const startupTimer = setTimeout(() => {
        if (!ready) {
          // Some playwright-mcp builds do not print a readiness banner; fall
          // back to attempting initialize once the startup timer fires.
          ready = true;
          this.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'openchrome-benchmark', version: '1.0.0' },
          })
            .then(() => resolve())
            .catch(reject);
        }
      }, this.startupTimeoutMs);
      startupTimer.unref();
    });
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const response = await this.send('tools/call', { name: toolName, arguments: args });
    if (response.error) {
      return errorResult(`playwright-mcp ${toolName} failed: ${response.error.message}`);
    }
    const result = response.result || {};
    return { content: result.content || [], isError: result.isError };
  }

  async stop(): Promise<void> {
    for (const [, slot] of this.pending) {
      clearTimeout(slot.timer);
      slot.reject(new Error('playwright-mcp transport stopped'));
    }
    this.pending.clear();
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
  }

  private send(method: string, params?: Record<string, unknown>): Promise<MCPResponse> {
    if (!this.process?.stdin) {
      return Promise.reject(new Error('playwright-mcp process not started'));
    }
    const id = ++this.requestId;
    const req: MCPRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<MCPResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`playwright-mcp "${method}" timed out after ${this.callTimeoutMs}ms`));
        }
      }, this.callTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin!.write(JSON.stringify(req) + '\n');
    });
  }
}

/**
 * Resolve the path to the bundled playwright-mcp CLI. The package's `exports`
 * field only allows `.` and `./package.json`, so we resolve via package.json
 * and join `cli.js` (its `bin` entry) ourselves. Lazy: the call only happens
 * at setup() so test discovery still works on a fresh checkout where the dep
 * is not yet installed.
 */
function defaultServerPath(): string {
  const pkgPath = require.resolve('@playwright/mcp/package.json');
  return path.join(path.dirname(pkgPath), 'cli.js');
}

export class PlaywrightMcpAdapter implements MCPAdapter {
  readonly name = 'playwright-mcp';
  readonly mode = 'a11y-snapshot';
  readonly kind = 'mcp' as const;

  private readonly cdpEndpoint: string;
  private readonly callTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly serverPathOverride?: string;
  private readonly injectedTransport?: PlaywrightMcpTransport;

  private transport: PlaywrightMcpTransport | null = null;
  // playwright-mcp manages tab order internally; we expose a stable synthetic
  // tabId to the benchmark and map it to a tab index for routing.
  private readonly tabIndexById = new Map<string, number>();
  private tabSeq = 0;
  // playwright-mcp's first tab is opened by `browser_navigate`; subsequent
  // tabs use `browser_tab_new`. This flag tracks whether we have established
  // the first one yet.
  private hasNavigatedOnce = false;

  constructor(options: PlaywrightMcpAdapterOptions = {}) {
    this.cdpEndpoint = options.cdpEndpoint ?? DEFAULT_CDP_ENDPOINT;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.serverPathOverride = options.serverPath;
    this.injectedTransport = options.transport;
  }

  async setup(): Promise<void> {
    this.transport =
      this.injectedTransport ??
      new SubprocessPlaywrightMcpTransport(
        this.cdpEndpoint,
        this.serverPathOverride ?? defaultServerPath(),
        this.callTimeoutMs,
        this.startupTimeoutMs,
      );
    await this.transport.start();
  }

  async teardown(): Promise<void> {
    if (this.transport) {
      await this.transport.stop();
      this.transport = null;
    }
    this.tabIndexById.clear();
    this.hasNavigatedOnce = false;
    this.tabSeq = 0;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.transport) {
      return errorResult('PlaywrightMcpAdapter: setup() was not called');
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
          return errorResult(`PlaywrightMcpAdapter: unsupported tool "${toolName}"`);
      }
    } catch (err) {
      return errorResult(`PlaywrightMcpAdapter: ${toolName} failed: ${(err as Error).message}`);
    }
  }

  private async createTab(args: Record<string, unknown>): Promise<MCPToolResult> {
    const url = typeof args.url === 'string' ? args.url : '';
    const transport = this.transport as PlaywrightMcpTransport;

    let tabIndex: number;
    if (!this.hasNavigatedOnce) {
      // First tab: drive the existing context's first page via browser_navigate.
      if (url && url !== 'about:blank') {
        const res = await transport.callTool('browser_navigate', { url });
        if (res.isError) return res;
      }
      this.hasNavigatedOnce = true;
      tabIndex = 0;
    } else {
      const res = await transport.callTool('browser_tab_new', url ? { url } : {});
      if (res.isError) return res;
      tabIndex = this.tabIndexById.size; // append
    }

    const tabId = `playwright-mcp-tab-${++this.tabSeq}`;
    this.tabIndexById.set(tabId, tabIndex);
    return textResult(JSON.stringify({ tabId }));
  }

  private async readPage(args: Record<string, unknown>): Promise<MCPToolResult> {
    const tabId = typeof args.tabId === 'string' ? args.tabId : '';
    const tabIndex = this.tabIndexById.get(tabId);
    if (tabIndex === undefined) {
      return errorResult(`PlaywrightMcpAdapter: unknown tabId "${tabId}"`);
    }
    const transport = this.transport as PlaywrightMcpTransport;
    if (this.tabIndexById.size > 1) {
      const sel = await transport.callTool('browser_tab_select', { index: tabIndex });
      if (sel.isError) return sel;
    }
    // playwright-mcp's idiomatic "hand this to an LLM" payload is the
    // accessibility snapshot — the right comparison baseline for the Token
    // Efficiency axis (#1256).
    const snap = await transport.callTool('browser_snapshot', {});
    if (snap.isError) return snap;
    return textResult(joinText(snap));
  }

  private async closeTab(args: Record<string, unknown>): Promise<MCPToolResult> {
    const tabId = typeof args.tabId === 'string' ? args.tabId : '';
    const closedIndex = this.tabIndexById.get(tabId);
    if (closedIndex === undefined) {
      return errorResult(`PlaywrightMcpAdapter: unknown tabId "${tabId}"`);
    }
    const transport = this.transport as PlaywrightMcpTransport;
    const res = await transport.callTool('browser_tab_close', { index: closedIndex });
    this.tabIndexById.delete(tabId);
    // playwright-mcp re-numbers tabs after a close: every tab whose index was
    // greater than the closed one shifts down by one. Mirror that here so
    // subsequent read_page / tabs_close calls target the correct tab.
    for (const [id, idx] of this.tabIndexById) {
      if (idx > closedIndex) {
        this.tabIndexById.set(id, idx - 1);
      }
    }
    if (res.isError) return res;
    return textResult(JSON.stringify({ closed: tabId }));
  }

  /** Number of tabs the adapter currently tracks — for assertions. */
  get openTabCount(): number {
    return this.tabIndexById.size;
  }
}
