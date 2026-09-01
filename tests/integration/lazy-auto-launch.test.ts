/// <reference types="jest" />

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { OWNER_SELF_RELEASE_EXIT_CODE } from '../../src/chrome/owner-self-release';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const HAS_BUILD = fs.existsSync(ENTRY);
const describeFn = HAS_BUILD && process.platform !== 'win32' ? describe : describe.skip;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function allocatePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to allocate port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForLog(getLog: () => string, pattern: RegExp, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(getLog())) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${pattern}. stderr:\n${getLog()}`);
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 20_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function terminate(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitForExit(child, 5_000);
  } catch {
    child.kill('SIGKILL');
    await waitForExit(child, 5_000).catch(() => undefined);
  }
}

function jsonFileCount(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).length;
}

class StdioRpcClient {
  private nextId = 1;
  private buffer = '';
  private pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const id = message.id;
        if (typeof id !== 'number') continue;
        const pending = this.pending.get(id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(message);
      }
    });
    child.once('exit', (code, signal) => {
      const error = new Error(`openchrome exited before RPC response (code=${code}, signal=${signal})`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
}

describeFn('lazy --auto-launch process contract (#1528)', () => {
  jest.setTimeout(60_000);

  test('protocol and browser-free tools stay launch-free; first browser call launches once and releases failed owner', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-lazy-startup-'));
    const home = path.join(tmp, 'home');
    const userDataDir = path.join(tmp, 'profile');
    const lockDir = path.join(tmp, 'locks');
    const brokerDir = path.join(tmp, 'brokers');
    const missingChrome = path.join(tmp, 'missing-chrome');
    fs.mkdirSync(home, { recursive: true });
    const [cdpPort, httpPort] = await Promise.all([allocatePort(), allocatePort()]);
    let child: ChildProcessWithoutNullStreams | null = null;
    let stderr = '';

    try {
      child = spawn(process.execPath, [
        ENTRY,
        'serve',
        '--auto-launch',
        '--headless',
        '--port', String(cdpPort),
        '--http', String(httpPort),
        '--http-host', '127.0.0.1',
        '--user-data-dir', userDataDir,
        '--chrome-binary', missingChrome,
      ], {
        cwd: REPO_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: home,
          OPENCHROME_CONTROLLER_LOCK_DIR: lockDir,
          OPENCHROME_BROKER_REGISTRY_DIR: brokerDir,
          OPENCHROME_PPID_WATCH: '0',
          OPENCHROME_HEALTH_ENDPOINT: '0',
          OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP: '1',
          OPENCHROME_LOCK_HEARTBEAT_INTERVAL_MS: '1000',
          OPENCHROME_MAX_RECONNECT_ATTEMPTS: '1',
          OPENCHROME_PROCESS_WATCHDOG_INTERVAL_MS: '60000',
          OPENCHROME_TAB_HEALTH_PROBE_INTERVAL_MS: '60000',
          OPENCHROME_RECOVERY_LEDGER: '0',
          CHROME_LAUNCH_TIMEOUT_MS: '1500',
        },
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      const rpc = new StdioRpcClient(child);

      await waitForLog(() => stderr, /Broker metadata: .*\(auto-elected\)/);
      expect(stderr).toContain('Chrome startup policy: lazy');
      expect(stderr).not.toContain('[ChromeLauncher] Launching Chrome');
      expect(child.exitCode).toBeNull();
      expect(jsonFileCount(lockDir)).toBe(1);
      expect(jsonFileCount(brokerDir)).toBe(1);

      const initialize = await rpc.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: true } },
        clientInfo: { name: 'claude-code', version: 'test' },
      });
      expect(initialize.error).toBeUndefined();
      expect((initialize.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe('openchrome');

      const toolsList = await rpc.request('tools/list');
      expect(toolsList.error).toBeUndefined();

      const launchFreeCalls: Array<[string, Record<string, unknown>]> = [
        ['expand_tools', { tier: '3' }],
        ['oc_connection_health', {}],
        ['oc_doctor_report', {}],
        ['oc_get_connection_info', { host: 'openchrome' }],
        ['list_profiles', { userDataDir }],
        ['oc_normalize_action', { action: { type: 'click', x: 1, y: 1 } }],
        ['oc_policy', { action: 'matrix' }],
        ['oc_assert', {
          contract: { kind: 'url', pattern: '^https://example\\.test/?$' },
          evidence: { snapshot: { url: 'https://example.test' } },
        }],
        ['oc_devtools_url', {}],
        ['memory', { action: 'query', domain: 'example.test' }],
        ['workflow_status', {}],
        ['worker', { action: 'list' }],
      ];
      for (const [name, args] of launchFreeCalls) {
        const response = await rpc.request('tools/call', { name, arguments: args });
        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
        expect(child.exitCode).toBeNull();
      }

      const crawlStart = await rpc.request('tools/call', {
        name: 'crawl_start',
        arguments: { url: 'https://example.test', max_pages: 1 },
      });
      const crawlStartContent = (crawlStart.result as { content?: Array<{ text?: string }> }).content;
      const crawlPayload = JSON.parse(crawlStartContent?.[0]?.text ?? '{}') as { jobId?: string };
      expect(crawlPayload.jobId).toBeDefined();

      for (const [name, args] of [
        ['crawl_status', { jobId: crawlPayload.jobId, advance: 0 }],
        ['crawl_cancel', { jobId: crawlPayload.jobId }],
      ] as Array<[string, Record<string, unknown>]>) {
        const response = await rpc.request('tools/call', { name, arguments: args });
        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
        expect(child.exitCode).toBeNull();
      }

      expect(stderr).not.toContain('[ChromeLauncher] Launching Chrome');
      expect(stderr).not.toContain('First browser/CDP-requiring operation requested');

      const navigateResponse = rpc.request('tools/call', {
        name: 'navigate',
        arguments: { url: 'about:blank' },
      }).catch(() => null);
      const exit = await waitForExit(child, 20_000);
      await navigateResponse;

      expect(exit.code).toBe(OWNER_SELF_RELEASE_EXIT_CODE);
      expect((stderr.match(/\[ChromeLauncher\] Launching Chrome/g) ?? []).length).toBe(1);
      expect((stderr.match(/First browser\/CDP-requiring operation requested/g) ?? []).length).toBe(1);
      expect(stderr).toContain('Startup Chrome launch failed after controller lock acquisition');
      expect(stderr).toContain('releasing controller lock and exiting');
      expect(jsonFileCount(lockDir)).toBe(0);
      expect(jsonFileCount(brokerDir)).toBe(0);
    } finally {
      await terminate(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--server-mode remains eager and attempts Chrome before opening the transport', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-eager-startup-'));
    const home = path.join(tmp, 'home');
    const lockDir = path.join(tmp, 'locks');
    const userDataDir = path.join(tmp, 'profile');
    const missingChrome = path.join(tmp, 'missing-chrome');
    fs.mkdirSync(home, { recursive: true });
    const cdpPort = await allocatePort();
    let child: ChildProcessWithoutNullStreams | null = null;
    let stderr = '';

    try {
      child = spawn(process.execPath, [
        ENTRY,
        'serve',
        '--server-mode',
        '--no-auto-elect',
        '--port', String(cdpPort),
        '--user-data-dir', userDataDir,
        '--chrome-binary', missingChrome,
      ], {
        cwd: REPO_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: home,
          OPENCHROME_CONTROLLER_LOCK_DIR: lockDir,
          OPENCHROME_PPID_WATCH: '0',
          OPENCHROME_HEALTH_ENDPOINT: '0',
          OPENCHROME_RECOVERY_LEDGER: '0',
          CHROME_LAUNCH_TIMEOUT_MS: '1500',
        },
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

      const exit = await waitForExit(child, 20_000);
      expect(exit.code).toBe(OWNER_SELF_RELEASE_EXIT_CODE);
      expect(stderr).toContain('Chrome startup policy: eager');
      expect(stderr).toContain('[ChromeLauncher] Launching Chrome');
      expect(stderr).not.toContain('STDIO transport enabled');
      expect(jsonFileCount(lockDir)).toBe(0);
    } finally {
      await terminate(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('eager startup does not open a transport after an inconclusive debug-port timeout', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-eager-timeout-'));
    const home = path.join(tmp, 'home');
    const lockDir = path.join(tmp, 'locks');
    const userDataDir = path.join(tmp, 'profile');
    const slowChrome = path.join(tmp, 'slow-chrome.sh');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(slowChrome, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    const cdpPort = await allocatePort();
    let child: ChildProcessWithoutNullStreams | null = null;
    let stderr = '';

    try {
      child = spawn(process.execPath, [
        ENTRY,
        'serve',
        '--server-mode',
        '--no-auto-elect',
        '--port', String(cdpPort),
        '--user-data-dir', userDataDir,
        '--chrome-binary', slowChrome,
      ], {
        cwd: REPO_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: home,
          OPENCHROME_CONTROLLER_LOCK_DIR: lockDir,
          OPENCHROME_PPID_WATCH: '0',
          OPENCHROME_HEALTH_ENDPOINT: '0',
          OPENCHROME_RECOVERY_LEDGER: '0',
          CHROME_LAUNCH_TIMEOUT_MS: '300',
        },
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

      const exit = await waitForExit(child, 20_000);
      expect(exit.code).not.toBe(0);
      expect(stderr).toContain('Chrome debug port');
      expect(stderr).toContain('Startup Chrome launch timed out; keeping ownership');
      expect(stderr).not.toContain('STDIO transport enabled');
      expect(jsonFileCount(lockDir)).toBe(0);
    } finally {
      await terminate(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('HTTP mode preserves Chrome-ready eager startup', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-http-eager-startup-'));
    const home = path.join(tmp, 'home');
    const lockDir = path.join(tmp, 'locks');
    const userDataDir = path.join(tmp, 'profile');
    const missingChrome = path.join(tmp, 'missing-chrome');
    fs.mkdirSync(home, { recursive: true });
    const [cdpPort, httpPort] = await Promise.all([allocatePort(), allocatePort()]);
    let child: ChildProcessWithoutNullStreams | null = null;
    let stderr = '';

    try {
      child = spawn(process.execPath, [
        ENTRY,
        'serve',
        '--auto-launch',
        '--no-auto-elect',
        '--http', String(httpPort),
        '--http-host', '127.0.0.1',
        '--port', String(cdpPort),
        '--user-data-dir', userDataDir,
        '--chrome-binary', missingChrome,
      ], {
        cwd: REPO_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: home,
          OPENCHROME_CONTROLLER_LOCK_DIR: lockDir,
          OPENCHROME_PPID_WATCH: '0',
          OPENCHROME_HEALTH_ENDPOINT: '0',
          OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP: '1',
          OPENCHROME_RECOVERY_LEDGER: '0',
          CHROME_LAUNCH_TIMEOUT_MS: '1500',
        },
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

      const exit = await waitForExit(child, 20_000);
      expect(exit.code).toBe(OWNER_SELF_RELEASE_EXIT_CODE);
      expect(stderr).toContain('Chrome startup policy: eager');
      expect(stderr).toContain('[ChromeLauncher] Launching Chrome');
      expect(stderr).not.toContain('HTTP transport enabled');
      expect(jsonFileCount(lockDir)).toBe(0);
    } finally {
      await terminate(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
