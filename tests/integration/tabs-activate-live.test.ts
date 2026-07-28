/// <reference types="jest" />

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { MCPClient } from '../e2e/harness/mcp-client';

const liveDescribe = process.env.OPENCHROME_LIVE_TABS_ACTIVATE === '1' ? describe : describe.skip;

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve a local port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function startFixture(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html><body><main id="state">${req.url ?? '/'}</main><script>
window.__visibleTicks = 0;
setInterval(() => {
  if (document.visibilityState === 'visible') window.__visibleTicks += 1;
}, 50);
</script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server has no TCP address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function parseJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`tool response contains no JSON object: ${text.slice(0, 200)}`);
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
    else if (char === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1)) as Record<string, unknown>;
    }
  }
  throw new Error(`tool response contains incomplete JSON: ${text.slice(0, 200)}`);
}

async function pageState(client: MCPClient, tabId: string): Promise<{
  visibilityState: string;
  documentFocused: boolean;
  visibleTicks: number;
}> {
  const result = await client.callTool('javascript_tool', {
    tabId,
    code: 'JSON.stringify({visibilityState:document.visibilityState,documentFocused:document.hasFocus(),visibleTicks:window.__visibleTicks})',
  });
  return parseJson(result.text) as {
    visibilityState: string;
    documentFocused: boolean;
    visibleTicks: number;
  };
}

liveDescribe('tabs_activate headed Chrome integration', () => {
  let client: MCPClient;
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  let profileDir: string;

  beforeAll(async () => {
    fixture = await startFixture();
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-tabs-activate-'));
    const chromePort = await reservePort();
    client = new MCPClient({
      timeoutMs: 60_000,
      env: {
        OPENCHROME_AUTO_ELECT: '0',
        OPENCHROME_HEADLESS: '0',
      },
      args: [
        '--no-auto-elect',
        '--all-tools',
        '--port', String(chromePort),
        '--user-data-dir', profileDir,
        '--window-bounds', '80,80,900,700',
      ],
    });
    await client.start();
  }, 90_000);

  afterAll(async () => {
    await client?.stop().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  }, 30_000);

  test('moves a hidden tab to visible, advances visible-only work, and orders concurrent activation', async () => {
    const createdA = parseJson((await client.callTool('tabs_create', { url: `${fixture.baseUrl}/a` })).text);
    const createdB = parseJson((await client.callTool('tabs_create', { url: `${fixture.baseUrl}/b` })).text);
    const tabA = String(createdA.tabId);
    const tabB = String(createdB.tabId);

    const activateA = parseJson((await client.callTool('tabs_activate', { tabId: tabA })).text);
    expect(activateA).toMatchObject({
      tabId: tabA,
      activated: true,
      outcome: 'verified',
      visibilityState: 'visible',
      windowForegroundAttempted: false,
      pathTaken: 'Target.activateTarget',
    });

    const hiddenStart = await pageState(client, tabB);
    expect(hiddenStart.visibilityState).toBe('hidden');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const hiddenEnd = await pageState(client, tabB);
    expect(hiddenEnd.visibilityState).toBe('hidden');
    expect(hiddenEnd.visibleTicks - hiddenStart.visibleTicks).toBeLessThanOrEqual(1);

    const activateB = parseJson((await client.callTool('tabs_activate', { tabId: tabB })).text);
    expect(activateB).toMatchObject({
      tabId: tabB,
      activated: true,
      outcome: 'verified',
      visibilityState: 'visible',
      windowForegroundAttempted: false,
      pathTaken: 'Target.activateTarget',
    });
    expect(typeof activateB.documentFocused).toBe('boolean');
    expect(Number(activateB.attempts)).toBeGreaterThanOrEqual(1);
    expect(Number(activateB.attempts)).toBeLessThanOrEqual(3);

    const visibleStart = await pageState(client, tabB);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const visibleEnd = await pageState(client, tabB);
    expect(visibleEnd.visibilityState).toBe('visible');
    expect(visibleEnd.visibleTicks - visibleStart.visibleTicks).toBeGreaterThanOrEqual(2);

    const [racedA, racedB] = await Promise.all([
      client.callTool('tabs_activate', { tabId: tabA }),
      client.callTool('tabs_activate', { tabId: tabB }),
    ]);
    const raceResults = [parseJson(racedA.text), parseJson(racedB.text)];
    expect(raceResults.some((result) => result.outcome === 'superseded')).toBe(true);
    expect(raceResults.some((result) => result.tabId === tabB && result.outcome === 'verified')).toBe(true);
    expect((await pageState(client, tabB)).visibilityState).toBe('visible');
    expect((await pageState(client, tabA)).visibilityState).toBe('hidden');
  }, 90_000);
});
