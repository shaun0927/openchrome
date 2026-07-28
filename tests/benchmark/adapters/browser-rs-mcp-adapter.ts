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

export interface BrowserRsConnectTarget {
  argument: string;
  endpoint: string;
  probeUrl: string;
  port: number;
}

export interface BrowserRsCdpProbeResult {
  ok: boolean;
  endpoint: string;
  browserVersion: string;
  message: string;
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
  chromeVersion: string;
  profilePath: string;
  connectPort?: number;
  connectEndpoint?: string;
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
const STOP_GRACE_MS = 500;
const STDERR_TAIL_CHARS = 16_384;

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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

function parseConnectTarget(raw: string): BrowserRsConnectTarget | null {
  if (/^\d+$/.test(raw)) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    const endpoint = `http://127.0.0.1:${port}`;
    return { argument: raw, endpoint, probeUrl: `${endpoint}/json/version`, port };
  }

  if (!raw.includes('://')) return null;
  try {
    const parsed = new URL(raw);
    const port = Number(parsed.port);
    if (!parsed.port || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    const probe = new URL(parsed.toString());
    const basePath = probe.pathname.replace(/\/$/, '');
    probe.pathname = basePath.endsWith('/json/version') ? basePath : `${basePath}/json/version`;
    return {
      argument: raw,
      endpoint: parsed.toString(),
      probeUrl: probe.toString(),
      port,
    };
  } catch {
    return null;
  }
}

function pinnedConnectCompatibilityError(target: BrowserRsConnectTarget): string | null {
  const endpoint = new URL(target.endpoint);
  if (endpoint.protocol !== 'http:') {
    return `browser-rs v${BROWSER_RS_PIN.version} reduces --connect to a local HTTP port; protocol ${endpoint.protocol} cannot be preserved`;
  }
  if (endpoint.hostname !== '127.0.0.1') {
    return `browser-rs v${BROWSER_RS_PIN.version} discards the --connect host and attaches through 127.0.0.1; refusing endpoint ${target.endpoint}`;
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) {
    return `browser-rs v${BROWSER_RS_PIN.version} discards --connect credentials, path, query, or fragment; refusing endpoint ${target.endpoint}`;
  }
  return null;
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

function probeCdpEndpoint(target: BrowserRsConnectTarget): BrowserRsCdpProbeResult {
  const script = [
    "const endpoint=new URL(process.argv[1]);",
    "const client=require(endpoint.protocol==='https:'?'https':'http');",
    'const req=client.get(endpoint,{timeout:1000},res=>{',
    "let body='';res.on('data',c=>body+=c);res.on('end',()=>{",
    "try{const value=JSON.parse(body);if(res.statusCode!==200||typeof value.webSocketDebuggerUrl!=='string'||typeof value.Browser!=='string')process.exit(1);process.stdout.write(JSON.stringify({browserVersion:value.Browser}));}catch{process.exit(1)}})});",
    'req.on(\'error\',()=>process.exit(1));req.on(\'timeout\',()=>{req.destroy();process.exit(1)});',
  ].join('');
  try {
    const output = execFileSync(process.execPath, ['-e', script, target.probeUrl], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(output) as { browserVersion?: unknown };
    if (typeof parsed.browserVersion !== 'string' || parsed.browserVersion.length === 0) {
      throw new Error('CDP version response did not identify the browser');
    }
    return {
      ok: true,
      endpoint: target.endpoint,
      browserVersion: parsed.browserVersion,
      message: 'compatible CDP endpoint',
    };
  } catch (error) {
    return {
      ok: false,
      endpoint: target.endpoint,
      browserVersion: '',
      message: `CDP probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function executableVersion(executablePath: string): string | null {
  try {
    const output = execFileSync(executablePath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return output || null;
  } catch {
    return null;
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
  resolveChromeVersion?: (chromePath: string) => string | null;
  profileConflict?: (profilePath: string) => boolean;
  connectProbe?: (target: BrowserRsConnectTarget) => BrowserRsCdpProbeResult;
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
    chromeVersion: '',
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

  let actualSha256 = '';
  try {
    actualSha256 = options.hashFile ? options.hashFile(binaryPath) : sha256File(binaryPath);
  } catch (err) {
    return { ...resolvedBase, status: 'sha_mismatch', message: `browser-rs SHA-256 check failed: ${(err as Error).message}` };
  }

  if (actualSha256 !== pin.sha256) {
    return {
      ...resolvedBase,
      actualSha256,
      status: 'sha_mismatch',
      message: `browser-rs SHA-256 mismatch: expected ${pin.sha256}, got ${actualSha256}`,
    };
  }
  const digestBase = { ...resolvedBase, actualSha256 };

  let versionOutput = '';
  try {
    versionOutput = options.execVersion
      ? options.execVersion(binaryPath)
      : execFileSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return { ...digestBase, status: 'missing_binary', message: `verified browser-rs --version failed: ${(err as Error).message}` };
  }

  const actualVersion = extractVersion(versionOutput);
  if (actualVersion !== BROWSER_RS_PIN.version) {
    return {
      ...digestBase,
      actualVersion,
      status: 'version_mismatch',
      message: `browser-rs version mismatch: expected ${BROWSER_RS_PIN.version}, got ${actualVersion || 'unknown'}`,
    };
  }

  const identityBase = { ...digestBase, actualVersion };
  if (optionValue(args, ['--port']) !== undefined || env.AB_HTTP) {
    return {
      ...identityBase,
      status: 'port_conflict',
      message: 'browser-rs --port/AB_HTTP selects HTTP mode and conflicts with the stdio benchmark adapter',
    };
  }

  const connectValue = optionValue(args, ['--connect', '--cdp-endpoint']) ?? env.AB_CONNECT;
  const connectTarget = connectValue ? parseConnectTarget(connectValue) : null;
  if (connectValue && !connectTarget) {
    return { ...identityBase, status: 'port_conflict', message: `browser-rs connect target is invalid: ${connectValue}` };
  }
  if (connectTarget) {
    const incompatibility = pinnedConnectCompatibilityError(connectTarget);
    if (incompatibility) {
      return {
        ...identityBase,
        connectPort: connectTarget.port,
        connectEndpoint: connectTarget.endpoint,
        status: 'port_conflict',
        message: incompatibility,
      };
    }
    const probe = (options.connectProbe ?? probeCdpEndpoint)(connectTarget);
    if (!probe.ok) {
      return {
        ...identityBase,
        connectPort: connectTarget.port,
        connectEndpoint: connectTarget.endpoint,
        status: 'port_conflict',
        message: `browser-rs connect endpoint ${connectTarget.endpoint} is unavailable: ${probe.message}`,
      };
    }
    return {
      ...identityBase,
      status: 'ok',
      connectPort: connectTarget.port,
      connectEndpoint: connectTarget.endpoint,
      chromeVersion: probe.browserVersion,
      message: 'browser-rs binary, configured CDP endpoint, version, and SHA-256 match the pinned benchmark contract',
    };
  }

  let chromePath = '';
  let chromeVersion = '';
  let profilePath = '';
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
  chromeVersion = (options.resolveChromeVersion ?? executableVersion)(chromePath) ?? '';
  if (!chromeVersion) {
    return {
      ...identityBase,
      chromePath,
      profilePath,
      status: 'chrome_missing',
      message: `Chrome version probe failed for approved executable: ${chromePath}`,
    };
  }
  const environmentBase = { ...identityBase, chromePath, chromeVersion, profilePath };

  return {
    ...environmentBase,
    status: 'ok',
    message: 'browser-rs binary, Chrome/profile preflight, version, and SHA-256 match the pinned benchmark contract',
  };
}

export function browserRsSpawnEnv(
  preflight: BrowserRsPreflightResult,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const spawnEnv = { ...env };
  if (preflight.chromePath) spawnEnv.AB_CHROME = preflight.chromePath;
  if (preflight.profilePath) spawnEnv.AB_PROFILE = preflight.profilePath;
  if (preflight.connectPort !== undefined) spawnEnv.AB_CONNECT = String(preflight.connectPort);
  return spawnEnv;
}

export class SubprocessBrowserRsMcpTransport implements BrowserRsMcpTransport {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private buffer = '';
  private stderrTail = '';
  private readonly pending = new Map<
    number,
    { resolve: (r: MCPResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  readonly command: readonly string[];

  constructor(
    private readonly binaryPath: string,
    args: readonly string[],
    private readonly callTimeoutMs: number,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.command = [binaryPath, ...args];
  }

  async start(): Promise<void> {
    if (this.process) throw new Error('browser-rs process already started');
    return new Promise((resolve, reject) => {
      const child = spawn(this.binaryPath, this.command.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env,
      });
      this.process = child;
      let settled = false;

      child.stdout?.on('data', (data: Buffer) => {
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

      child.stderr?.on('data', (data: Buffer) => {
        this.stderrTail = `${this.stderrTail}${data.toString()}`.slice(-STDERR_TAIL_CHARS);
      });
      child.stdin?.on('error', (error) => {
        this.rejectPending(this.diagnosticError(`browser-rs stdin failed: ${error.message}`));
      });

      child.once('spawn', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      child.once('error', (error) => {
        if (this.process === child) this.process = null;
        const failure = this.diagnosticError(`browser-rs process error: ${error.message}`);
        this.rejectPending(failure);
        if (!settled) {
          settled = true;
          reject(failure);
        }
      });
      child.once('exit', (code, signal) => {
        if (this.process === child) this.process = null;
        const failure = this.diagnosticError(`browser-rs exited with code ${code} signal ${signal}`);
        this.rejectPending(failure);
        if (!settled) {
          settled = true;
          reject(failure);
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
    const child = this.process;
    this.process = null;
    this.rejectPending(new Error('browser-rs transport stopped'));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
      try { child.stdin.end(); } catch { /* process cleanup below is authoritative */ }
    }
    if (await this.waitForExit(child, STOP_GRACE_MS)) return;
    try { child.kill('SIGTERM'); } catch { /* process may have exited between checks */ }
    if (await this.waitForExit(child, STOP_GRACE_MS)) return;
    try { child.kill('SIGKILL'); } catch { /* process may have exited between checks */ }
    await this.waitForExit(child, STOP_GRACE_MS);
  }

  private send(method: string, params?: Record<string, unknown>): Promise<MCPResponse> {
    const child = this.process;
    const input = child?.stdin;
    if (!child || child.exitCode !== null || child.signalCode !== null || !input || input.destroyed || !input.writable) {
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
      input.write(`${JSON.stringify(req)}\n`, (error?: Error | null) => {
        if (!error) return;
        const slot = this.pending.get(id);
        if (!slot) return;
        clearTimeout(slot.timer);
        this.pending.delete(id);
        slot.reject(this.diagnosticError(`browser-rs "${method}" write failed: ${error.message}`));
      });
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const child = this.process;
    const input = child?.stdin;
    if (!child || child.exitCode !== null || child.signalCode !== null || !input || input.destroyed || !input.writable) {
      return Promise.reject(new Error('browser-rs process not started'));
    }
    return new Promise<void>((resolve, reject) => {
      input.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, (error?: Error | null) => {
        if (error) reject(this.diagnosticError(`browser-rs "${method}" write failed: ${error.message}`));
        else resolve();
      });
    });
  }

  private rejectPending(error: Error): void {
    for (const [, slot] of this.pending) {
      clearTimeout(slot.timer);
      slot.reject(error);
    }
    this.pending.clear();
  }

  private diagnosticError(message: string): Error {
    const diagnostics = this.stderrTail.trim();
    return new Error(diagnostics ? `${message}\nbrowser-rs stderr tail:\n${diagnostics}` : message);
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit);
        resolve(false);
      }, timeoutMs);
      timer.unref();
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once('exit', onExit);
    });
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
        browserRsSpawnEnv(preflight),
      );
    } else {
      this.transport = this.injectedTransport;
    }

    try {
      await withTimeout((async () => {
        await this.transport!.start();
        await this.transport!.initialize();
      })(), this.startupTimeoutMs, 'browser-rs startup');
      const tools = await this.transport.listTools();
      this.toolCountValue = tools.length;
      this.setupFinishedAt = Date.now();
    } catch (error) {
      await this.transport.stop().catch(() => undefined);
      this.transport = null;
      throw error;
    }
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
