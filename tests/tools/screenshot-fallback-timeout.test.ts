/**
 * Tests for fallback screenshot timeout behavior.
 *
 * Verifies that click-element, interact, and batch-paginate tools
 * wrap fallback page.screenshot() in Promise.race with DEFAULT_SCREENSHOT_TIMEOUT_MS
 * so a dialog-blocked page cannot cause an indefinite hang.
 *
 * Strategy: Read the source files and verify the timeout pattern exists,
 * then test the Promise.race timeout pattern directly.
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_SCREENSHOT_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// 1. Static verification: source files contain the timeout pattern
// ---------------------------------------------------------------------------

describe('fallback screenshot timeout — source verification', () => {
  const srcDir = path.join(__dirname, '../../src/tools');

  const files = [
    { name: 'click-element.ts', tool: 'click_element' },
    { name: 'interact.ts', tool: 'interact' },
    { name: 'batch-paginate.ts', tool: 'batch_paginate' },
  ];

  for (const { name, tool } of files) {
    describe(tool, () => {
      let source: string;

      beforeAll(() => {
        source = fs.readFileSync(path.join(srcDir, name), 'utf-8');
      });

      test('imports DEFAULT_SCREENSHOT_TIMEOUT_MS', () => {
        expect(source).toContain('DEFAULT_SCREENSHOT_TIMEOUT_MS');
      });

      test('wraps fallback page.screenshot in Promise.race', () => {
        // After the CDP screenshot catch block, there should be Promise.race around page.screenshot
        expect(source).toMatch(/Promise\.race\(\s*\[\s*page\.screenshot\(/s);
      });

      test('uses setTimeout with DEFAULT_SCREENSHOT_TIMEOUT_MS for the race timeout', () => {
        expect(source).toMatch(/setTimeout\(.*DEFAULT_SCREENSHOT_TIMEOUT_MS/s);
      });

      test('has "Fallback screenshot timed out" error message', () => {
        expect(source).toContain('Fallback screenshot timed out');
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Behavioral test: Promise.race timeout pattern works correctly
// ---------------------------------------------------------------------------

describe('fallback screenshot timeout — behavioral', () => {
  test('fast screenshot resolves before timeout', async () => {
    const fastScreenshot = Promise.resolve('base64-data');
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Fallback screenshot timed out')), DEFAULT_SCREENSHOT_TIMEOUT_MS);
    });

    const result = await Promise.race([fastScreenshot, timeout]);
    clearTimeout(timer!);
    expect(result).toBe('base64-data');
  });

  test('hanging screenshot is rejected by timeout', async () => {
    // Use a short timeout for test speed
    const FAST_TIMEOUT = 50;
    const hangingScreenshot = new Promise<string>(() => {}); // never resolves
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Fallback screenshot timed out')), FAST_TIMEOUT)
    );

    await expect(Promise.race([hangingScreenshot, timeout])).rejects.toThrow(
      'Fallback screenshot timed out'
    );
  });

  test('screenshot error propagates even with timeout', async () => {
    const failingScreenshot = Promise.reject(new Error('Page crashed'));
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Fallback screenshot timed out')), DEFAULT_SCREENSHOT_TIMEOUT_MS);
    });

    await expect(Promise.race([failingScreenshot, timeout])).rejects.toThrow('Page crashed');
    clearTimeout(timer!);
  });

  test('timeout value matches DEFAULT_SCREENSHOT_TIMEOUT_MS (15000)', () => {
    // Verify the constant imported from defaults matches expected value
    // This catches accidental changes to the timeout value
    const defaults = require('../../src/config/defaults');
    expect(defaults.DEFAULT_SCREENSHOT_TIMEOUT_MS).toBe(15000);
  });
});
