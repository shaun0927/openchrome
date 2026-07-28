/**
 * browser-rs-mcp competitor adapter for the competitive benchmark suite (#1554).
 *
 * This adapter treats browser-rs as an externally supplied MCP stdio binary.
 * It does not download, vendor, or import browser-rs internals. Live runs must
 * provide BROWSER_RS_BIN, and setup fails closed unless the binary reports the
 * pinned version and its SHA-256 matches the pinned release asset for the
 * current platform.
 */

import { spawn, execFileSync, ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
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
    tools?: BrowserRsMcpTool[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

export interface BrowserRsMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface BrowserRsMcpTransport {
  start(): Promise<void>;
  initialize(): Promise<void>;
  listTools(): Promise<BrowserRsMcpTool[]>;
  callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult>;
  stop(): Promise<void>;
  readonly command: readonly string[];
}

export interface BrowserRsMcpAdapterOptions {
  /** Path to the maintainer-supplied browser-rs binary. Defaults to BROWSER_RS_BIN. */
  binaryPath?: string;
  /** Extra CLI arguments. The benchmark default uses browser-rs' stdio mode with no flags. */
  args?: readonly string[];
  /** Per-call timeout in ms (default 30s). */
  callTimeoutMs?: number;
  /** Startup timeout in ms (default 15s). */
  startupTimeoutMs?: number;
  /** Injected transport for deterministic tests. Skips subprocess construction and binary preflight. */
  transport?: BrowserRsMcpTransport;
}

export interface BrowserRsPlatformPin {
  asset: string;
  sha256: string;
}

export type BrowserRsPreflightStatus =
  | 'ok'
  | 'missing_binary'
  | 'unsupported_platform'
  | 'version_mismatch'
  | 'sha_mismatch'
  | 'chrome_missing'
  | 'profile_conflict'
  | 'port_conflict';

export interface BrowserRsPreflightResult {
  status: BrowserRsPreflightStatus;
  binaryPath: string;
  command: readonly string[];
  platformKey: string;
  expectedVersion: string;
  actualVersion: string;
  expectedSha256: string;
  actualSha256: string;
  asset: string;
  commit: string;
  chromePath: string;
  profilePath: string;
  connectPort?: number;
  message: string;
}

export const BROWSER_RS_PIN = {
  library: 'browser-rs-mcp',
  binary: 'browser-rs',
  version: '0.1.13',
  commit: '6efa54fe428f1203967a9c760a27d0647d5474ee',
  license: 'Apache-2.0',
  measuredAt: '2026-07-27 release asset',
  platforms: {
    'linux-x64': {
      asset: 'browser-rs-linux-x64',
      sha256: 'ae0e4f5d2a4e6a90a0f050c50a55fcb86aab7cdda7d1ea2fec1aa54a321e3f1c',
    },
    'darwin-arm64': {
      asset: 'browser-rs-macos-arm64',
      sha256: '618c75dc4f9c3297ba85d4e1ddaa9aaf67a671bc8abb393e1f64523dc084b310',
    },
  } satisfies Record<string, BrowserRsPlatformPin>,
} as const;

const DEFAULT_CALL_TIMEOUT_MS = 30000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;

function textResult(text: string): MCPToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): MCPToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function joinText(result: MCPToolResult): string {
  return (result.content || [])
    .map((entry) => (typeof entry.text === 'string' ? entry.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

function extractVersion(output: string): string {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? '';
}

export function browserRsPlatformKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
}

export function browserRsPlatformPin(platform = process.platform, arch = process.arch): BrowserRsPlatformPin | null {
  const key = browserRsPlatformKey(platform, arch);
  return (BROWSER_RS_PIN.platforms as Record<string, BrowserRsPlatformPin | undefined>)[key] ?? null;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(fs.readFileSync(path)).digest('hex');
}

function commandCandidates(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const pathEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (platform !== 'win32') return pathEntries.map((entry) => path.join(entry, command));
  const extensions = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return pathEntries.flatMap((entry) => extensions.map((extension) => path.join(entry, `${command}${extension}`)));
}

function canonicalExecutable(
  value: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd = process.cwd(),
): string {
  const candidates = path.isAbsolute(value) || value.includes(path.sep)
    ? [path.resolve(cwd, value)]
    : commandCandidates(value, env, platform);
  for (const candidate of candidates) {
    try {
      const canonical = fs.realpathSync(candidate);
      const stat = fs.statSync(canonical);
      if (!stat.isFile()) continue;
      if (platform !== 'win32') fs.accessSync(canonical, fs.constants.X_OK);
      return canonical;
    } catch {
      // Keep looking through PATH candidates.
    }
  }
  throw new Error(`executable not found or not runnable: ${value}`);
}

function resolveBrowserRsChrome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const explicit = env.AB_CHROME ?? env.OPENCHROME_BENCH_CHROME_PATH ?? env.CHROME_PATH;
  if (explicit) {
    try { return canonicalExecutable(explicit, env, platform); } catch { return null; }
  }
  const candidates = platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    : platform === 'win32'
      ? [
          env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
          env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ].filter((candidate): candidate is string => Boolean(candidate))
      : ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
  for (const candidate of candidates) {
    try { return canonicalExecutable(candidate, env, platform); } catch { /* continue */ }
  }
  return null;
}

function optionValue(args: readonly string[], names: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    for (const name of names) {
      if (arg === name) return args[index + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function configuredConnectPort(args: readonly string[], env: NodeJS.ProcessEnv): number | undefined {
  const raw = optionValue(args, ['--connect', '--cdp-endpoint']) ?? env.AB_CONNECT;
  if (!raw) return undefined;
  const numericPort = /^\d+$/.test(raw) ? Number(raw) : undefined;
  let urlPort: number | undefined;
  if (numericPort === undefined) {
    try {
      const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
      const inferred = parsed.port || (parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? '443' : '80');
      urlPort = Number(inferred);
    } catch {
      urlPort = undefined;
    }
  }
  const port = numericPort ?? urlPort;
  if (port === undefined || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  return port;
}

function configuredProfilePath(args: readonly string[], env: NodeJS.ProcessEnv): string {
  const configured = optionValue(args, ['--user-data-dir', '--profile']) ?? env.AB_PROFILE;
  if (configured) return path.resolve(configured);
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  return home ? path.join(home, '.browser-rs', 'profile') : '';
}

function profileHasLock(profilePath: string): boolean {
  if (!profilePath) return false;
  return ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].some((name) => {
    try {
      fs.lstatSync(path.join(profilePath, name));
      return true;
    } catch {
      return false;
    }
  });
}

function probeCdpPort(port: number): boolean {
  const script = [
    "const http=require('http');",
    'const port=Number(process.argv[1]);',
    "const req=http.get({hostname:'127.0.0.1',port,path:'/json/version',timeout:1000},res=>{",
    "let body='';res.on('data',c=>body+=c);res.on('end',()=>{",
    "try{const value=JSON.parse(body);process.exit(res.statusCode===200&&typeof value.webSocketDebuggerUrl==='string'?0:1)}catch{process.exit(1)}})});",
    'req.on(\'error\',()=>process.exit(1));req.on(\'timeout\',()=>{req.destroy();process.exit(1)});',
  ].join('');
  try {
    execFileSync(process.execPath, ['-e', script, String(port)], { timeout: 2000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function preflightBrowserRsBinary(options: {
  binaryPath?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  execVersion?: (binaryPath: string) => string;
  hashFile?: (binaryPath: string) => string;
  resolveBinary?: (binaryPath: string) => string;
  resolveChrome?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | null;
  profileConflict?: (profilePath: string) => boolean;
  connectProbe?: (port: number) => boolean;
} = {}): BrowserRsPreflightResult {
  const env = options.env ?? process.env;
  const requestedBinaryPath = options.binaryPath ?? env.BROWSER_RS_BIN ?? '';
  const args = options.args ?? [];
  const platform = options.platform ?? process.platform;
  const platformKey = browserRsPlatformKey(platform, options.arch ?? process.arch);
  const pin = browserRsPlatformPin(platform, options.arch ?? process.arch);
  let binaryPath = requestedBinaryPath;
  const base = {
    binaryPath,
    command: binaryPath ? [binaryPath, ...args] : [],
    platformKey,
    expectedVersion: BROWSER_RS_PIN.version,
    actualVersion: '',
    expectedSha256: pin?.sha256 ?? '',
    actualSha256: '',
    asset: pin?.asset ?? '',
    commit: BROWSER_RS_PIN.commit,
    chromePath: '',
    profilePath: '',
  };

  if (!pin) {
    return { ...base, status: 'unsupported_platform', message: `browser-rs has no pinned release asset for ${platformKey}` };
  }
  if (!requestedBinaryPath) {
    return { ...base, status: 'missing_binary', message: 'BROWSER_RS_BIN is required for browser-rs live smoke' };
  }

  try {
    binaryPath = options.resolveBinary
      ? options.resolveBinary(requestedBinaryPath)
      : canonicalExecutable(requestedBinaryPath, env, platform);
  } catch (err) {
    return {
      ...base,
      status: 'missing_binary',
      message: `browser-rs binary path is not a canonical runnable file: ${(err as Error).message}`,
    };
  }
  const resolvedBase = { ...base, binaryPath, command: [binaryPath, ...args] };

  let versionOutput = '';
  try {
    versionOutput = options.execVersion
      ? options.execVersion(binaryPath)
      : execFileSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return { ...resolvedBase, status: 'missing_binary', message: `browser-rs --version failed: ${(err as Error).message}` };
  }

  const actualVersion = extractVersion(versionOutput);
  if (actualVersion !== BROWSER_RS_PIN.version) {
    return {
      ...resolvedBase,
      actualVersion,
      status: 'version_mismatch',
      message: `browser-rs version mismatch: expected ${BROWSER_RS_PIN.version}, got ${actualVersion || 'unknown'}`,
    };
  }

  let actualSha256 = '';
  try {
    actualSha256 = options.hashFile ? options.hashFile(binaryPath) : sha256File(binaryPath);
  } catch (err) {
    return { ...resolvedBase, actualVersion, status: 'sha_mismatch', message: `browser-rs SHA-256 check failed: ${(err as Error).message}` };
  }

  if (actualSha256 !== pin.sha256) {
    return {
      ...resolvedBase,
      actualVersion,
      actualSha256,
      status: 'sha_mismatch',
      message: `browser-rs SHA-256 mismatch: expected ${pin.sha256}, got ${actualSha256}`,
    };
  }

  const identityBase = { ...resolvedBase, actualVersion, actualSha256 };
  if (optionValue(args, ['--port']) !== undefined || env.AB_HTTP) {
    return {
      ...identityBase,
      status: 'port_conflict',
      message: 'browser-rs --port/AB_HTTP selects HTTP mode and conflicts with the stdio benchmark adapter',
    };
  }

  const connectPort = configuredConnectPort(args, env);
  if ((optionValue(args, ['--connect', '--cdp-endpoint']) ?? env.AB_CONNECT) && connectPort === undefined) {
    return { ...identityBase, status: 'port_conflict', message: 'browser-rs connect port is invalid' };
  }
  if (connectPort !== undefined && !(options.connectProbe ?? probeCdpPort)(connectPort)) {
    return {
      ...identityBase,
      connectPort,
      status: 'port_conflict',
      message: `browser-rs connect port ${connectPort} does not expose a compatible CDP endpoint`,
    };
  }

  let chromePath = '';
  let profilePath = '';
  if (connectPort === undefined) {
    chromePath = (options.resolveChrome ?? resolveBrowserRsChrome)(env, platform) ?? '';
    if (!chromePath) {
      return {
        ...identityBase,
        status: 'chrome_missing',
        message: 'Chrome/Chromium is required for browser-rs live smoke; set AB_CHROME to a canonical executable path',
      };
    }
    profilePath = configuredProfilePath(args, env);
    if (!profilePath) {
      return { ...identityBase, chromePath, status: 'profile_conflict', message: 'browser-rs profile path could not be resolved' };
    }
    if ((options.profileConflict ?? profileHasLock)(profilePath)) {
      return {
        ...identityBase,
        chromePath,
        profilePath,
        status: 'profile_conflict',
        message: `browser-rs profile is already locked: ${profilePath}`,
      };
    }
  }
  const environmentBase = { ...identityBase, chromePath, profilePath, connectPort };

  return {
    ...environmentBase,
    status: 'ok',
    message: 'browser-rs binary, Chrome/profile preflight, version, and SHA-256 match the pinned benchmark contract',
  };
}

class SubprocessBrowserRsMcpTransport implements BrowserRsMcpTransport {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private buffer = '';
  private readonly pending = new Map<
    number,
    { resolve: (r: MCPResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  readonly command: readonly string[];

  constructor(
    private readonly binaryPath: string,
    args: readonly string[],
    private readonly callTimeoutMs: number,
    private readonly startupTimeoutMs: number,
  ) {
    this.command = [binaryPath, ...args];
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.binaryPath, this.command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
      let settled = false;
      const startupTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`browser-rs startup timed out after ${this.startupTimeoutMs}ms`));
        }
      }, this.startupTimeoutMs);
      startupTimer.unref();

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
            // MCP stdout should be JSON-only. Ignore stray lines defensively.
          }
        }
      });

      this.process.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(startupTimer);
          reject(err);
        }
      });
      this.process.on('exit', (code) => {
        for (const [, slot] of this.pending) {
          clearTimeout(slot.timer);
          slot.reject(new Error(`browser-rs exited with code ${code}`));
        }
        this.pending.clear();
        if (!settled) {
          settled = true;
          clearTimeout(startupTimer);
          reject(new Error(`browser-rs exited with code ${code} before startup`));
        }
      });

      setImmediate(() => {
        if (!settled) {
          settled = true;
          clearTimeout(startupTimer);
          resolve();
        }
      });
    });
  }

  async initialize(): Promise<void> {
    const response = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'openchrome-benchmark', version: '1.0.0' },
    });
    if (response.error) throw new Error(`browser-rs initialize failed: ${response.error.message}`);
    await this.sendNotification('notifications/initialized');
  }

  async listTools(): Promise<BrowserRsMcpTool[]> {
    const response = await this.send('tools/list', {});
    if (response.error) throw new Error(`browser-rs tools/list failed: ${response.error.message}`);
    return response.result?.tools ?? [];
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const response = await this.send('tools/call', { name: toolName, arguments: args });
    if (response.error) {
      return errorResult(`browser-rs ${toolName} failed: ${response.error.message}`);
    }
    const result = response.result || {};
    return { content: result.content || [], isError: result.isError };
  }

  async stop(): Promise<void> {
    try {
      if (this.process?.stdin) await this.send('shutdown', {});
    } catch {
      // Best-effort graceful shutdown; process cleanup below is authoritative.
    }
    for (const [, slot] of this.pending) {
      clearTimeout(slot.timer);
      slot.reject(new Error('browser-rs transport stopped'));
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
      return Promise.reject(new Error('browser-rs process not started'));
    }
    const id = ++this.requestId;
    const req: MCPRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<MCPResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`browser-rs "${method}" timed out after ${this.callTimeoutMs}ms`));
        }
      }, this.callTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin!.write(JSON.stringify(req) + '\n');
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.process?.stdin) {
      return Promise.reject(new Error('browser-rs process not started'));
    }
    this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    return Promise.resolve();
  }
}

export class BrowserRsMcpAdapter implements MCPAdapter {
  readonly name = 'browser-rs-mcp';
  readonly mode = 'a11y-snapshot-stdio';
  readonly kind = 'mcp' as const;
  readonly version = BROWSER_RS_PIN.version;

  private readonly binaryPath?: string;
  private readonly args: readonly string[];
  private readonly callTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly injectedTransport?: BrowserRsMcpTransport;

  private transport: BrowserRsMcpTransport | null = null;
  private pageId: string | null = null;
  private toolCountValue = 0;
  private lastPreflightValue: BrowserRsPreflightResult | null = null;
  private setupStartedAt = 0;
  private setupFinishedAt = 0;

  constructor(options: BrowserRsMcpAdapterOptions = {}) {
    this.binaryPath = options.binaryPath;
    this.args = options.args ?? [];
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.injectedTransport = options.transport;
  }

  async setup(): Promise<void> {
    this.setupStartedAt = Date.now();
    if (!this.injectedTransport) {
      const preflight = preflightBrowserRsBinary({ binaryPath: this.binaryPath, args: this.args });
      this.lastPreflightValue = preflight;
      if (preflight.status !== 'ok') throw new Error(preflight.message);
      this.transport = new SubprocessBrowserRsMcpTransport(
        preflight.binaryPath,
        this.args,
        this.callTimeoutMs,
        this.startupTimeoutMs,
      );
    } else {
      this.transport = this.injectedTransport;
    }

    await this.transport.start();
    await this.transport.initialize();
    const tools = await this.transport.listTools();
    this.toolCountValue = tools.length;
    this.setupFinishedAt = Date.now();
  }

  async teardown(): Promise<void> {
    if (this.transport) {
      await this.transport.stop();
      this.transport = null;
    }
    this.pageId = null;
    this.toolCountValue = 0;
    this.setupStartedAt = 0;
    this.setupFinishedAt = 0;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.transport) {
      return errorResult('BrowserRsMcpAdapter: setup() was not called');
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
          return errorResult(`BrowserRsMcpAdapter: unsupported tool "${toolName}"`);
      }
    } catch (err) {
      return errorResult(`BrowserRsMcpAdapter: ${toolName} failed: ${(err as Error).message}`);
    }
  }

  get toolCount(): number {
    return this.toolCountValue;
  }

  get command(): readonly string[] {
    return this.transport?.command ?? [];
  }

  get lastPreflight(): BrowserRsPreflightResult | null {
    return this.lastPreflightValue;
  }

  get setupDurationMs(): number {
    return this.setupFinishedAt > this.setupStartedAt ? this.setupFinishedAt - this.setupStartedAt : 0;
  }

  private async createTab(args: Record<string, unknown>): Promise<MCPToolResult> {
    const url = typeof args.url === 'string' ? args.url : '';
    const result = await (this.transport as BrowserRsMcpTransport).callTool('browser_navigate', { url });
    if (result.isError) return result;
    const text = joinText(result);
    const pageId = parsePageId(text);
    if (!pageId) {
      return errorResult('BrowserRsMcpAdapter: browser_navigate returned no page id');
    }
    this.pageId = pageId;
    return textResult(JSON.stringify({ tabId: pageId }));
  }

  private async readPage(args: Record<string, unknown>): Promise<MCPToolResult> {
    const tabId = typeof args.tabId === 'string' ? args.tabId : '';
    const page = tabId || this.pageId;
    if (!page || page !== this.pageId) {
      return errorResult(`BrowserRsMcpAdapter: unknown tabId "${tabId}"`);
    }
    const result = await (this.transport as BrowserRsMcpTransport).callTool('browser_snapshot', { page });
    if (result.isError) return result;
    return textResult(joinText(result));
  }

  private async closeTab(args: Record<string, unknown>): Promise<MCPToolResult> {
    const tabId = typeof args.tabId === 'string' ? args.tabId : '';
    if (!this.pageId || tabId !== this.pageId) {
      return errorResult(`BrowserRsMcpAdapter: unknown tabId "${tabId}"`);
    }
    const result = await (this.transport as BrowserRsMcpTransport).callTool('browser_close_page', { page: this.pageId });
    if (result.isError) return result;
    const closed = this.pageId;
    this.pageId = null;
    return textResult(JSON.stringify({ closed }));
  }
}

function parsePageId(text: string): string {
  const match = text.match(/^page\s+([^\s]+)/m);
  return match?.[1] ?? '';
}
