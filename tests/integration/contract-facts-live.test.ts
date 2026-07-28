/// <reference types="jest" />

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { MCPClient } from '../e2e/harness/mcp-client';

const liveDescribe = process.env.OPENCHROME_LIVE_CONTRACT_FACTS === '1'
  ? describe
  : describe.skip;

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function parseJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`tool response contains no JSON: ${text.slice(0, 200)}`);
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

liveDescribe('performance and console contract facts - real headed Chrome', () => {
  let client: MCPClient;
  let rootDir: string;

  beforeAll(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-contract-facts-live-'));
    const chromePort = await reservePort();
    client = new MCPClient({
      timeoutMs: 60_000,
      env: {
        HOME: rootDir,
        OPENCHROME_AUTO_ELECT: '0',
        OPENCHROME_HEADLESS: '0',
      },
      args: [
        '--no-auto-elect',
        '--all-tools',
        '--port', String(chromePort),
        '--user-data-dir', path.join(rootDir, 'profile'),
        '--window-bounds', '120,120,900,700',
      ],
    });
    await client.start();
  }, 90_000);

  afterAll(async () => {
    await client?.stop().catch(() => undefined);
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  }, 30_000);

  test('collector facts drive one console and one performance postcondition', async () => {
    const created = parseJson((await client.callTool('tabs_create', { url: 'about:blank' })).text);
    const tabId = String(created.tabId);
    expect(tabId).not.toBe('undefined');

    await client.callTool('console_capture', { tabId, action: 'start' });
    await client.callTool('javascript_tool', {
      tabId,
      code: [
        'document.title = "Contract facts fixture";',
        'document.body.innerHTML = "<main id=\\"ready\\">ready</main>";',
        'console.error("contract-console-marker");',
        '"emitted";',
      ].join(' '),
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const consolePayload = parseJson((await client.callTool('console_capture', {
      tabId,
      action: 'get',
    })).text);
    const consoleFacts = consolePayload.contract_facts as unknown[];
    expect(consoleFacts).toHaveLength(1);

    const consoleAssertion = parseJson((await client.callTool('oc_assert', {
      contract: {
        kind: 'console',
        schema_version: 1,
        type: 'error',
        message_pattern: '^contract-console-marker$',
        uncaught: false,
        op: 'eq',
        value: 1,
        max_age_ms: 30000,
      },
      evidence: {
        provenance: { target_id: tabId },
        snapshot: { contract_facts: consoleFacts },
      },
    })).text);
    expect(consoleAssertion.verdict).toBe('pass');

    const performancePayload = parseJson((await client.callTool('performance_metrics', {
      tabId,
      type: 'puppeteer',
    })).text);
    const performanceFacts = performancePayload.contract_facts as Array<Record<string, unknown>>;
    expect(performanceFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'puppeteer.Documents', unit: 'count' }),
    ]));

    const performanceAssertion = parseJson((await client.callTool('oc_assert', {
      contract: {
        kind: 'performance',
        schema_version: 1,
        metric: 'puppeteer.Documents',
        unit: 'count',
        op: 'gte',
        value: 1,
        max_age_ms: 30000,
      },
      evidence: {
        provenance: { target_id: tabId },
        snapshot: { contract_facts: performanceFacts },
      },
    })).text);
    expect(performanceAssertion.verdict).toBe('pass');

    await client.callTool('console_capture', { tabId, action: 'stop' });
  }, 90_000);
});
