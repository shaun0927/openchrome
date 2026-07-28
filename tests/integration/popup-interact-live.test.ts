jest.unmock('puppeteer-core');
jest.unmock('../../src/chrome/launcher');

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

import {
  _resetCDPClientFactoryForTesting,
  _resetCDPClientForTesting,
  getCDPClient,
} from '../../src/cdp/client';
import { getCDPConnectionPool } from '../../src/cdp/connection-pool';
import { getGlobalConfig, setGlobalConfig, type GlobalConfig } from '../../src/config/global';
import { _resetSessionManagerForTesting, getSessionManager, type SessionManager } from '../../src/session-manager';
import { registerInteractTool } from '../../src/tools/interact';

const REAL_CHROME = process.env.OPENCHROME_REAL_CHROME === '1';

function findChromeExecutable(): string | null {
  if (process.env.OPENCHROME_TEST_CHROME) return process.env.OPENCHROME_TEST_CHROME;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a TCP port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture server did not expose a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function buttonCenter(page: Page, selector: string): Promise<{ x: number; y: number }> {
  return page.$eval(selector, (element) => {
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  });
}

(REAL_CHROME ? describe : describe.skip)('interact popup ledger - real headed Chrome', () => {
  let browser: Browser;
  let fixtureServer: http.Server;
  let fixturePort: number;
  let userDataDir: string;
  let manager: SessionManager;
  let page: Page;
  let tabId: string;
  let interact: (sessionId: string, args: Record<string, unknown>) => Promise<any>;
  let previousConfig: GlobalConfig | undefined;
  const sessionId = 'popup-live';

  beforeAll(async () => {
    const executablePath = findChromeExecutable();
    if (!executablePath) throw new Error('No Chrome executable found');

    fixtureServer = http.createServer((request, response) => {
      const url = request.url ?? '/';
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (url === '/') {
        response.end(`<!doctype html>
          <title>Popup fixture</title>
          <button id="direct" onclick="window.open('/direct', '_blank')">Direct child</button>
          <button id="delayed" onclick="const w = window.open('about:blank', '_blank'); setTimeout(() => { if (w) w.location = '/delayed'; }, 100)">Delayed child</button>
          <button id="blocked" onclick="window.open('http://localhost:${fixturePort}/blocked', '_blank')">Blocked child</button>`);
        return;
      }
      if (url === '/direct') {
        response.end('<!doctype html><title>Direct child</title><h1>Direct child</h1>');
        return;
      }
      if (url === '/delayed') {
        response.end('<!doctype html><title>Delayed child</title><h1>Delayed child</h1>');
        return;
      }
      response.end('<!doctype html><title>Blocked child</title><h1>Blocked child</h1>');
    });
    fixturePort = await listen(fixtureServer);

    const chromePort = await reservePort();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-popup-live-'));
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir,
      args: [
        `--remote-debugging-port=${chromePort}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
      ],
    });

    previousConfig = { ...getGlobalConfig(), security: getGlobalConfig().security ? { ...getGlobalConfig().security } : undefined };
    setGlobalConfig({
      port: chromePort,
      autoLaunch: false,
      security: { blocked_domains: ['localhost'] },
    });
    process.env.OC_PERSIST_STORAGE = '0';
    _resetSessionManagerForTesting();
    _resetCDPClientForTesting();
    _resetCDPClientFactoryForTesting();

    manager = getSessionManager();
    manager.stopAutoCleanup();
    await manager.ensureConnected();
    const created = await manager.createTarget(sessionId, `http://127.0.0.1:${fixturePort}/`);
    tabId = created.targetId;
    page = created.page;

    let registered: typeof interact | undefined;
    registerInteractTool({
      registerTool: (_name: string, handler: typeof interact) => { registered = handler; },
    } as never);
    if (!registered) throw new Error('interact handler was not registered');
    interact = registered;
  }, 180_000);

  afterAll(async () => {
    await manager?.cleanupAllSessions().catch(() => {});
    manager?.stopAutoCleanup();
    await getCDPConnectionPool().shutdown().catch(() => {});
    await getCDPClient().disconnect().catch(() => {});
    await browser?.close().catch(() => {});
    if (fixtureServer) await closeServer(fixtureServer);
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    if (previousConfig) setGlobalConfig(previousConfig);
    delete process.env.OC_PERSIST_STORAGE;
    _resetSessionManagerForTesting();
    _resetCDPClientForTesting();
    _resetCDPClientFactoryForTesting();
  }, 180_000);

  test('reports direct and delayed children, omits blocked children, and keeps using the source tab', async () => {
    const directCoordinate = await buttonCenter(page, '#direct');
    const direct = await interact(sessionId, {
      tabId,
      mode: 'coordinate',
      coordinate: directCoordinate,
      waitAfter: 500,
    });
    expect(direct.openedTabCount).toBe(1);
    expect(direct.openedTabs[0]).toMatchObject({
      workerId: 'default',
      url: `http://127.0.0.1:${fixturePort}/direct`,
      status: 'ready',
    });

    const delayedCoordinate = await buttonCenter(page, '#delayed');
    const delayed = await interact(sessionId, {
      tabId,
      mode: 'coordinate',
      coordinate: delayedCoordinate,
      waitAfter: 700,
    });
    expect(delayed.openedTabCount).toBe(1);
    expect(delayed.openedTabs[0].url).toBe(`http://127.0.0.1:${fixturePort}/delayed`);

    const blockedCoordinate = await buttonCenter(page, '#blocked');
    const blocked = await interact(sessionId, {
      tabId,
      mode: 'coordinate',
      coordinate: blockedCoordinate,
      waitAfter: 500,
    });
    expect(blocked).not.toHaveProperty('openedTabCount');
    expect(blocked).not.toHaveProperty('openedTabs');

    expect(page.url()).toBe(`http://127.0.0.1:${fixturePort}/`);
    expect(manager.getTargetOwner(tabId)).toEqual({ sessionId, workerId: 'default' });
  }, 180_000);
});

describe('interact popup ledger - live test compile smoke', () => {
  test('fixture gate is explicit', () => {
    expect(typeof REAL_CHROME).toBe('boolean');
  });
});
