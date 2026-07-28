/// <reference types="jest" />

jest.mock('../../src/session-manager', () => ({ getSessionManager: jest.fn() }));

import * as fs from 'fs';
import type { Browser, CDPSession, Page } from 'puppeteer-core';

import { CDPClient } from '../../src/cdp/client';
import { isConnectionError } from '../../src/mcp-server';
import { getSessionManager } from '../../src/session-manager';
import { registerJavascriptTool } from '../../src/tools/javascript';
import type { MCPResult, ToolContext, ToolHandler } from '../../src/types/mcp';
import { getTargetId } from '../../src/utils/puppeteer-helpers';
import { withTimeout } from '../../src/utils/with-timeout';

const puppeteerModule = jest.requireActual<typeof import('puppeteer-core')>('puppeteer-core');
const puppeteer = puppeteerModule.default;

const REAL_CHROME = process.env.OPENCHROME_REAL_CHROME === '1';

interface RuntimeEvaluateValueResult {
  result: { value?: unknown };
}

function getResultText(result: MCPResult): string {
  return result.content?.[0]?.text ?? '';
}

function findChromeExecutable(): string | null {
  if (process.env.OPENCHROME_TEST_CHROME) {
    return process.env.OPENCHROME_TEST_CHROME;
  }
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      ]
    : process.platform === 'win32'
      ? [
          `${process.env.PROGRAMFILES ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['PROGRAMFILES(X86)'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
        ];

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

(REAL_CHROME ? describe : describe.skip)(
  'Runtime.evaluate renderer timeout - real Chrome',
  () => {
    let browser: Browser;
    let page: Page;
    let cdpClient: CDPClient;
    let managedSession: CDPSession;
    let targetId: string;
    let javascriptHandler: ToolHandler;

    const runJavascript = (
      code: string,
      timeout: number,
      context: ToolContext = { startTime: Date.now(), deadlineMs: 2_000 },
    ): Promise<MCPResult> => javascriptHandler(
      'live-session',
      { tabId: targetId, code, timeout },
      context,
    );

    beforeAll(async () => {
      const executablePath = findChromeExecutable();
      if (!executablePath) {
        throw new Error('OPENCHROME_REAL_CHROME=1 but no Chrome executable was found');
      }

      browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox'],
      });
      page = await browser.newPage();
      cdpClient = new CDPClient();
      targetId = getTargetId(page.target());
      cdpClient.indexExternalPage(targetId, page);
      managedSession = await cdpClient.getCDPSession(page);

      const liveSessionManager = {
        getPage: jest.fn(async (_sessionId: string, requestedTargetId: string) => (
          requestedTargetId === targetId ? page : null
        )),
        getAvailableTargets: jest.fn(async () => [{ tabId: targetId, url: page.url(), title: 'live test' }]),
        getCDPClient: jest.fn(() => cdpClient),
      };
      (getSessionManager as jest.Mock).mockReturnValue(liveSessionManager);

      registerJavascriptTool({
        registerTool: (name: string, handler: ToolHandler) => {
          if (name === 'javascript_tool') javascriptHandler = handler;
        },
      } as never);
    }, 30_000);

    afterAll(async () => {
      await managedSession?.detach().catch(() => {});
      const chromeProcess = browser?.process();
      let closeTimer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          browser?.close(),
          new Promise<never>((_, reject) => {
            closeTimer = setTimeout(() => reject(new Error('browser.close timed out')), 5_000);
          }),
        ]).finally(() => clearTimeout(closeTimer));
      } catch {
        chromeProcess?.kill('SIGKILL');
      }
    }, 15_000);

    test('terminates a synchronous runaway expression and preserves same-tab recovery', async () => {
      const callerTimeoutMs = 250;
      const started = Date.now();
      const timeoutResult = await runJavascript(
        'globalThis.__openchromePartialEffect = 1;\nwhile (true) {}',
        callerTimeoutMs,
      );
      const timeoutText = getResultText(timeoutResult);

      expect(timeoutResult.isError).toBe(true);
      expect(timeoutText).toContain('Protocol error (Runtime.evaluate)');
      expect(isConnectionError(timeoutText)).toBe(false);
      expect(Date.now() - started).toBeLessThan(2_000);

      const recovery = await runJavascript('21 * 2', 1_000);
      expect(recovery.isError).toBeUndefined();
      expect(getResultText(recovery)).toBe('42');

      const partialEffect = await runJavascript('globalThis.__openchromePartialEffect', 1_000);
      expect(getResultText(partialEffect)).toBe('1');
      await runJavascript('delete globalThis.__openchromePartialEffect', 1_000);
    });

    test('returns through the host timeout without claiming Promise cancellation', async () => {
      const callerTimeoutMs = 250;
      const started = Date.now();
      const rescueSession = await page.createCDPSession();
      try {
        const timeoutResult = await runJavascript(
          'new Promise((resolve) => { globalThis.__openchromeResolvePending = resolve; })',
          callerTimeoutMs,
        );
        const timeoutText = getResultText(timeoutResult);

        expect(timeoutResult.isError).toBe(true);
        expect(timeoutText).toMatch(/timed out|deadline exceeded/i);
        expect(isConnectionError(timeoutText)).toBe(false);
        expect(Date.now() - started).toBeLessThan(2_000);

        const probe = await withTimeout(
          rescueSession.send('Runtime.evaluate', {
            expression: 'typeof globalThis.__openchromeResolvePending',
            returnByValue: true,
          }) as Promise<RuntimeEvaluateValueResult>,
          500,
          'pending Promise live probe',
        ).then(
          (value) => ({ status: 'visible' as const, value }),
          (error) => ({ status: 'blocked' as const, error }),
        );

        if (probe.status === 'visible') {
          expect(probe.value.result.value).toBe('function');
          await withTimeout(
            rescueSession.send('Runtime.evaluate', {
              expression: 'globalThis.__openchromeResolvePending(42); delete globalThis.__openchromeResolvePending; true',
              returnByValue: true,
            }),
            1_000,
            'pending Promise resolver cleanup',
          );
        } else {
          expect(String(probe.error)).toMatch(/timed out/i);
          await withTimeout(
            rescueSession.send('Runtime.terminateExecution'),
            1_000,
            'pending Promise terminate cleanup',
          );
        }
      } finally {
        await rescueSession.detach();
      }

      const recovery = await runJavascript('6 * 7', 1_000);
      expect(recovery.isError).toBeUndefined();
      expect(getResultText(recovery)).toBe('42');
    });
  },
);
