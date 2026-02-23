/// <reference types="jest" />
/**
 * Tests for CookieSync (src/router/cookie-sync.ts)
 * TDD: Tests written first, implementation follows.
 */

import { CookieSync } from '../../../src/router/cookie-sync';
import type { Protocol } from 'puppeteer-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockCookie = Protocol.Network.Cookie;

function makeCookie(overrides: Partial<MockCookie> = {}): MockCookie {
  return {
    name: 'session',
    value: 'abc123',
    domain: 'example.com',
    path: '/',
    expires: -1,
    size: 10,
    httpOnly: false,
    secure: false,
    session: true,
    ...overrides,
  } as MockCookie;
}

function createMockPage(cookies: MockCookie[] = []) {
  return {
    cookies: jest.fn().mockResolvedValue(cookies),
    setCookie: jest.fn().mockResolvedValue(undefined),
    url: jest.fn().mockReturnValue('https://example.com'),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('CookieSync', () => {
  let sync: CookieSync;

  beforeEach(() => {
    sync = new CookieSync();
    jest.useFakeTimers();
  });

  afterEach(() => {
    sync.cleanup();
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  describe('chrome-to-lightpanda', () => {
    it('should copy all cookies from Chrome page to Lightpanda', async () => {
      const cookies = [makeCookie({ name: 'a' }), makeCookie({ name: 'b' })];
      const chromePage = createMockPage(cookies);
      const lightpandaPage = createMockPage();

      const count = await sync.chromeToLightpanda(
        chromePage as any,
        lightpandaPage as any,
      );

      expect(count).toBe(2);
      expect(lightpandaPage.setCookie).toHaveBeenCalledWith(...cookies);
    });

    it('should filter cookies by domain when domain specified', async () => {
      const matchCookie = makeCookie({ name: 'a', domain: 'example.com' });
      const otherCookie = makeCookie({ name: 'b', domain: 'other.com' });
      const chromePage = createMockPage([matchCookie, otherCookie]);
      const lightpandaPage = createMockPage();

      // page.cookies() called without domain arg - we filter client-side
      const count = await sync.chromeToLightpanda(
        chromePage as any,
        lightpandaPage as any,
        'example.com',
      );

      expect(count).toBe(1);
      expect(lightpandaPage.setCookie).toHaveBeenCalledWith(matchCookie);
    });

    it('should handle empty cookie jar gracefully', async () => {
      const chromePage = createMockPage([]);
      const lightpandaPage = createMockPage();

      const count = await sync.chromeToLightpanda(
        chromePage as any,
        lightpandaPage as any,
      );

      expect(count).toBe(0);
      expect(lightpandaPage.setCookie).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('lightpanda-to-chrome', () => {
    it('should copy cookies back on escalation', async () => {
      const lpCookies = [makeCookie({ name: 'lp_token', value: 'xyz' })];
      const lightpandaPage = createMockPage(lpCookies);
      const chromePage = createMockPage([]); // Chrome starts empty

      const count = await sync.lightpandaToChrome(
        lightpandaPage as any,
        chromePage as any,
      );

      expect(count).toBe(1);
      expect(chromePage.setCookie).toHaveBeenCalledWith(
        makeCookie({ name: 'lp_token', value: 'xyz' }),
      );
    });

    it('should merge (not overwrite) existing Chrome cookies', async () => {
      const existingChromeCookie = makeCookie({ name: 'existing', value: 'keep' });
      const lpCookie = makeCookie({ name: 'new_from_lp', value: 'fresh' });

      // Chrome already has 'existing'; Lightpanda also has it + a new one
      const chromePage = createMockPage([existingChromeCookie]);
      const lightpandaPage = createMockPage([existingChromeCookie, lpCookie]);

      const count = await sync.lightpandaToChrome(
        lightpandaPage as any,
        chromePage as any,
      );

      // Only the new cookie should be added (merge, not overwrite)
      expect(count).toBe(1);
      expect(chromePage.setCookie).toHaveBeenCalledWith(lpCookie);
      expect(chromePage.setCookie).not.toHaveBeenCalledWith(existingChromeCookie);
    });
  });

  // -------------------------------------------------------------------------
  describe('periodic sync', () => {
    it('should sync at configured interval (default 5s)', async () => {
      const cookies = [makeCookie()];
      const source = createMockPage(cookies);
      const target = createMockPage();

      sync.startPeriodicSync(source as any, target as any);

      // Before first tick - no sync yet
      expect(target.setCookie).not.toHaveBeenCalled();

      // Advance past one interval
      jest.advanceTimersByTime(5000);
      // Allow microtasks to settle
      await Promise.resolve();

      expect(target.setCookie).toHaveBeenCalled();
    });

    it('should stop sync on cleanup', async () => {
      const cookies = [makeCookie()];
      const source = createMockPage(cookies);
      const target = createMockPage();

      sync.startPeriodicSync(source as any, target as any);
      sync.cleanup();

      // Advance well past the interval - no sync should happen
      jest.advanceTimersByTime(30000);
      await Promise.resolve();

      expect(target.setCookie).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('should silently handle cookie sync failures (best-effort)', async () => {
      const brokenPage = {
        cookies: jest.fn().mockRejectedValue(new Error('CDP error')),
        setCookie: jest.fn(),
        url: jest.fn().mockReturnValue('https://example.com'),
      };
      const targetPage = createMockPage();

      // Should NOT throw
      await expect(
        sync.chromeToLightpanda(brokenPage as any, targetPage as any),
      ).resolves.toBe(0);

      expect(targetPage.setCookie).not.toHaveBeenCalled();
    });
  });
});
