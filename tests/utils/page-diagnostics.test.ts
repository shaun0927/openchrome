/**
 * Tests for detectBlockingPage() — structural heuristics and existing patterns.
 */

/// <reference types="jest" />

import { detectBlockingPage } from '../../src/utils/page-diagnostics';
import type { Page } from 'puppeteer-core';

/**
 * Creates a mock Page where page.evaluate(fn) runs fn() with a mocked document global.
 * This lets us test the actual detection logic rather than mock the return value.
 */
function createTestPage(
  title: string,
  bodyText: string,
  elementCount: number,
  selectorResults: Record<string, boolean> = {},
): Page {
  return {
    evaluate: jest.fn().mockImplementation(async (fn: (...args: any[]) => any) => {
      const mockDocument = {
        title,
        body: { innerText: bodyText },
        querySelectorAll: (sel: string) => {
          if (sel === '*') return { length: elementCount };
          return { length: 0 };
        },
        querySelector: (sel: string) => (selectorResults[sel] ? {} : null),
        readyState: 'complete',
      };

      const origDocument = (globalThis as any).document;
      const origLocation = (globalThis as any).location;

      Object.defineProperty(globalThis, 'document', {
        value: mockDocument,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(globalThis, 'location', {
        value: { href: 'https://example.com' },
        writable: true,
        configurable: true,
      });

      try {
        return fn();
      } finally {
        if (origDocument !== undefined) {
          Object.defineProperty(globalThis, 'document', {
            value: origDocument,
            writable: true,
            configurable: true,
          });
        }
        if (origLocation !== undefined) {
          Object.defineProperty(globalThis, 'location', {
            value: origLocation,
            writable: true,
            configurable: true,
          });
        }
      }
    }),
  } as unknown as Page;
}

describe('detectBlockingPage - structural heuristics', () => {
  describe('Reddit-style block — sparse page + "blocked by network security"', () => {
    it('returns access-denied for "You have been blocked by network security"', async () => {
      const page = createTestPage(
        'Access Restricted',
        'you have been blocked by network security. please contact your administrator.',
        42,
      );
      const result = await detectBlockingPage(page);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('access-denied');
    });

    it('returns access-denied for "blocked by" on a sparse page', async () => {
      const page = createTestPage(
        'Blocked',
        'your request has been blocked by our security system.',
        30,
      );
      const result = await detectBlockingPage(page);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('access-denied');
    });
  });

  describe('Rate limit / too many requests', () => {
    it('returns access-denied for "rate limit exceeded" on sparse page', async () => {
      const page = createTestPage(
        'Rate Limited',
        'rate limit exceeded. please slow down your requests.',
        20,
      );
      const result = await detectBlockingPage(page);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('access-denied');
    });

    it('returns access-denied for "too many requests" on sparse page', async () => {
      const page = createTestPage(
        '429',
        'too many requests. try again later.',
        15,
      );
      const result = await detectBlockingPage(page);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('access-denied');
    });
  });

  describe('Suspicious activity / unusual traffic', () => {
    it('returns access-denied for "suspicious activity detected" on sparse page', async () => {
      const page = createTestPage(
        'Security Warning',
        'suspicious activity detected from your ip address.',
        25,
      );
      const result = await detectBlockingPage(page);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('access-denied');
    });

    it('returns access-denied for "unusual traffic" on sparse page', async () => {
      const page = createTestPage(
        'Blocked',
        'unusual traffic detected. your access has been temporarily restricted.',
        18,
      );
      const result = await detectBlockingPage(page);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('access-denied');
    });
  });

  describe('False positive prevention — normal page', () => {
    it('returns null for a dense page (500+ elements) that mentions "blocked by"', async () => {
      const page = createTestPage(
        'Tech Blog',
        'this article discusses how websites get blocked by firewalls and what you can do about it.',
        600,
      );
      const result = await detectBlockingPage(page);
      expect(result).toBeNull();
    });

    it('returns null for a page with many elements even with short body text', async () => {
      const page = createTestPage(
        'Dashboard',
        'network security settings updated.',
        150,
      );
      const result = await detectBlockingPage(page);
      expect(result).toBeNull();
    });
  });

  describe('Sparse page with no blocking keywords', () => {
    it('returns null for a sparse page with generic content', async () => {
      const page = createTestPage(
        'Loading...',
        'please wait while we load your content.',
        10,
      );
      const result = await detectBlockingPage(page);
      expect(result).toBeNull();
    });

    it('returns null for a sparse page with empty body', async () => {
      const page = createTestPage('', '', 5);
      const result = await detectBlockingPage(page);
      expect(result).toBeNull();
    });
  });

  describe('Regression — existing patterns still work', () => {
    it('detects captcha via bodyText keyword', async () => {
      const page = createTestPage(
        'Verification',
        'please complete the captcha to continue.',
        200,
      );
      const result = await detectBlockingPage(page);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('captcha');
    });

    it('detects captcha via cloudflare iframe selector', async () => {
      const page = createTestPage(
        'Cloudflare',
        'just a moment...',
        80,
        { 'iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, .cf-turnstile': true },
      );
      const result = await detectBlockingPage(page);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('captcha');
    });

    it('detects bot-check for "verify you are human"', async () => {
      const page = createTestPage(
        'Security Check',
        'please verify you are human to continue.',
        300,
      );
      const result = await detectBlockingPage(page);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('bot-check');
    });

    it('detects access-denied via title', async () => {
      const page = createTestPage(
        'Access Denied',
        'you do not have permission to access this resource.',
        400,
      );
      const result = await detectBlockingPage(page);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('access-denied');
    });

    it('detects js-required', async () => {
      const page = createTestPage(
        'JavaScript Required',
        'please enable javascript to view this page.',
        50,
      );
      const result = await detectBlockingPage(page);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('js-required');
    });

    it('returns null for a normal page', async () => {
      const page = createTestPage(
        'Home | Example',
        'welcome to example.com. browse our products and services.',
        800,
      );
      const result = await detectBlockingPage(page);
      expect(result).toBeNull();
    });
  });

  describe('detail field', () => {
    it('uses document.title as detail when title is available', async () => {
      const page = createTestPage(
        'Network Security Block',
        'you have been blocked by network security.',
        30,
      );
      const result = await detectBlockingPage(page);
      expect(result?.detail).toBe('Network Security Block');
    });

    it('uses bodyText substring as detail when title is empty', async () => {
      const page = createTestPage(
        '',
        'you have been blocked by network security policy.',
        30,
      );
      const result = await detectBlockingPage(page);
      expect(result?.detail).toBeTruthy();
      expect(result?.detail.length).toBeGreaterThan(0);
    });
  });
});
