/// <reference types="jest" />
/**
 * Tests for page-diagnostics utility — detectBlockingPage access-denied patterns
 */

import type { Page } from 'puppeteer-core';

// Helper to build a minimal mock Page that runs the evaluate callback
// against a simulated DOM environment.
function makeMockPage(opts: { title: string; bodyText: string }): Page {
  const evaluate = jest.fn().mockImplementation((fn: Function) => {
    // Simulate the browser-side environment the function receives
    const document = {
      title: opts.title,
      body: { innerText: opts.bodyText },
      querySelector: () => null,
    };
    // Replace global document inside the evaluated function
    return Promise.resolve(
      fn.call(
        {},
        // The function closes over `document` via the browser context.
        // We inject it by re-binding; since the fn is serialised and re-evaluated,
        // we just call it with the globals set on globalThis temporarily.
        ...[]
      )
    );
  });

  // Provide a thin shim: override global document/location for the evaluate call
  const realEvaluate = async (fn: Function) => {
    const savedDoc = (global as any).document;
    const savedLoc = (global as any).location;

    (global as any).document = {
      title: opts.title,
      body: { innerText: opts.bodyText },
      querySelector: () => null,
    };
    (global as any).location = { href: 'https://example.com' };

    try {
      return await fn();
    } finally {
      (global as any).document = savedDoc;
      (global as any).location = savedLoc;
    }
  };

  return { evaluate: realEvaluate } as unknown as Page;
}

// Import after the helper so we can use the mock
import { detectBlockingPage } from '../../src/utils/page-diagnostics';

describe('detectBlockingPage — access-denied patterns', () => {
  test('"blocked by network security" in body → access-denied', async () => {
    const page = makeMockPage({
      title: 'Network Error',
      bodyText: "You've been blocked by network security.",
    });

    const result = await detectBlockingPage(page);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('access-denied');
  });

  test('"you\'ve been blocked" in short body → access-denied', async () => {
    const page = makeMockPage({
      title: 'Blocked',
      bodyText: "You've been blocked from accessing this page.",
    });

    const result = await detectBlockingPage(page);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('access-denied');
  });

  test('"you have been blocked" in short body → access-denied', async () => {
    const page = makeMockPage({
      title: 'Access Restricted',
      bodyText: 'You have been blocked from this website.',
    });

    const result = await detectBlockingPage(page);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('access-denied');
  });

  test('title "Blocked" → access-denied', async () => {
    const page = makeMockPage({
      title: 'Blocked',
      bodyText: 'This page is not available.',
    });

    const result = await detectBlockingPage(page);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('access-denied');
  });

  test('long body with "you\'ve been blocked" (>500 chars) → NOT detected (avoid false positives)', async () => {
    const longBody =
      "You've been blocked " + 'a'.repeat(490);

    const page = makeMockPage({
      title: 'Some Article',
      bodyText: longBody,
    });

    const result = await detectBlockingPage(page);
    // Should not trigger access-denied for a long page that merely mentions the phrase
    expect(result?.type).not.toBe('access-denied');
  });

  test('normal page → returns null', async () => {
    const page = makeMockPage({
      title: 'Welcome to Reddit',
      bodyText: 'Top posts from r/programming today.',
    });

    const result = await detectBlockingPage(page);
    expect(result).toBeNull();
  });
});
