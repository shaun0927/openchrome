/**
 * Safe page.title() wrapper with timeout.
 *
 * page.title() internally calls page.evaluate(() => document.title),
 * which can hang for up to 30s if the renderer is frozen or mid-navigation.
 * This wrapper adds a short timeout and returns '' on failure.
 */

import type { Page } from 'puppeteer-core';
import { DEFAULT_SAFE_TITLE_TIMEOUT_MS } from '../config/defaults';
import { withTimeout } from './with-timeout';

export async function safeTitle(
  page: Page,
  timeoutMs: number = DEFAULT_SAFE_TITLE_TIMEOUT_MS,
): Promise<string> {
  try {
    return await withTimeout(page.title(), timeoutMs, 'page.title()');
  } catch {
    return '';
  }
}
