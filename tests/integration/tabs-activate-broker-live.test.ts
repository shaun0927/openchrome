/// <reference types="jest" />

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { terminateChild } from '../e2e/harness/child-process';

const liveDescribe = process.env.OPENCHROME_LIVE_TABS_ACTIVATE_BROKER === '1' ? describe : describe.skip;

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve a port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function startFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><main>${req.url ?? '/'}</main></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server has no address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function firstJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`response contains no JSON object: ${text.slice(0, 200)}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(text.slice(start, index + 1));
  }
  throw new Error(`response contains incomplete JSON: ${text.slice(0, 200)}`);
}

interface JsonRpcResponse {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

class BrokerSessionClient {
  private requestId = 0;
  private sessionId = '';

  constructor(private readonly endpoint: string) {}

  async initialize(name: string): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name, version: '1.0.0' },
    });
    if (!this.sessionId) throw new Error('broker did not return Mcp-Session-Id');
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error) throw new Error(`JSON-RPC ${response.error.code}: ${response.error.message}`);
    const content = response.result?.content ?? [];
    return {
      text: content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n'),
      isError: response.result?.isError === true,
    };
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    await fetch(this.endpoint, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': this.sessionId },
    }).catch(() => undefined);
    this.sessionId = '';
  }

  private async request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params }),
    });
    const returnedSession = response.headers.get('mcp-session-id');
    if (returnedSession) this.sessionId = returnedSession;
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const data = text.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim();
      if (!data) throw new Error(`SSE response contains no data frame: ${text.slice(0, 200)}`);
      return JSON.parse(data) as JsonRpcResponse;
    }
    return JSON.parse(text) as JsonRpcResponse;
  }
}

liveDescribe('tabs_activate broker live verification', () => {
  let brokerProcess: ChildProcess;
  let clientA: BrokerSessionClient;
  let clientB: BrokerSessionClient;
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  let profileDir: string;

  beforeAll(async () => {
    fixture = await startFixture();
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-tabs-broker-'));
    const httpPort = await reservePort();
    const cdpPort = await reservePort();
    const endpoint = `http://127.0.0.1:${httpPort}/mcp`;
    const serverPath = path.join(process.cwd(), 'dist', 'index.js');
    brokerProcess = spawn(process.execPath, [
      serverPath,
      'serve',
      '--broker',
      '--http', String(httpPort),
      '--http-host', '127.0.0.1',
      '--allow-unauthenticated-http',
      '--auto-launch',
      '--all-tools',
      '--port', String(cdpPort),
      '--user-data-dir', profileDir,
      '--window-bounds', '100,100,900,700',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENCHROME_AUTO_ELECT: '0',
        OPENCHROME_HEADLESS: '0',
      },
    });

    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`broker startup timeout: ${stderr.slice(-2000)}`)), 30_000);
      brokerProcess.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr = `${stderr}${chunk}`.slice(-4000);
        if (process.env.DEBUG) process.stderr.write(`[tabs-activate-broker] ${chunk}`);
        if (stderr.includes(`[HTTPTransport] Listening on 127.0.0.1:${httpPort}`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      brokerProcess.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      brokerProcess.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`broker exited before ready: code=${code} signal=${signal} ${stderr.slice(-2000)}`));
      });
    });

    clientA = new BrokerSessionClient(endpoint);
    clientB = new BrokerSessionClient(endpoint);
    await Promise.all([
      clientA.initialize('tabs-activate-a'),
      clientB.initialize('tabs-activate-b'),
    ]);
  }, 90_000);

  afterAll(async () => {
    await clientA?.callTool('oc_stop', { keepChrome: false }).catch(() => undefined);
    await Promise.all([clientA?.close(), clientB?.close()]);
    if (brokerProcess) await terminateChild(brokerProcess).catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    if (profileDir) {
      await fs.promises.rm(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    }
  }, 30_000);

  test('rejects cross-session activation and serializes two owner-routed clients', async () => {
    const createdA = firstJsonObject((await clientA.callTool('tabs_create', { url: `${fixture.url}/a` })).text);
    const createdB = firstJsonObject((await clientB.callTool('tabs_create', { url: `${fixture.url}/b` })).text);
    const tabA = String(createdA.tabId);
    const tabB = String(createdB.tabId);

    const activateB = firstJsonObject((await clientB.callTool('tabs_activate', { tabId: tabB })).text);
    expect(activateB).toMatchObject({ tabId: tabB, outcome: 'verified', visibilityState: 'visible' });

    const denied = await clientB.callTool('tabs_activate', { tabId: tabA });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/does not belong|stale|not found/i);

    const stateB = firstJsonObject((await clientB.callTool('javascript_tool', {
      tabId: tabB,
      code: 'JSON.stringify({visibilityState:document.visibilityState})',
    })).text);
    const stateA = firstJsonObject((await clientA.callTool('javascript_tool', {
      tabId: tabA,
      code: 'JSON.stringify({visibilityState:document.visibilityState})',
    })).text);
    expect(stateB.visibilityState).toBe('visible');
    expect(stateA.visibilityState).toBe('hidden');

    const [resultA, resultB] = await Promise.all([
      clientA.callTool('tabs_activate', { tabId: tabA }),
      clientB.callTool('tabs_activate', { tabId: tabB }),
    ]);
    const parsedA = firstJsonObject(resultA.text);
    const parsedB = firstJsonObject(resultB.text);
    const outcomes = [parsedA.outcome, parsedB.outcome];
    expect(outcomes).toContain('superseded');
    expect(outcomes).toContain('verified');

    const finalA = firstJsonObject((await clientA.callTool('javascript_tool', {
      tabId: tabA,
      code: 'JSON.stringify({visibilityState:document.visibilityState})',
    })).text);
    const finalB = firstJsonObject((await clientB.callTool('javascript_tool', {
      tabId: tabB,
      code: 'JSON.stringify({visibilityState:document.visibilityState})',
    })).text);
    const verifiedTab = parsedA.outcome === 'verified' ? tabA : tabB;
    expect(verifiedTab === tabA ? finalA.visibilityState : finalB.visibilityState).toBe('visible');
    expect(verifiedTab === tabA ? finalB.visibilityState : finalA.visibilityState).toBe('hidden');
  }, 90_000);
});
