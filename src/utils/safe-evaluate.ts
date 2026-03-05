import type { Page } from 'puppeteer-core';
import { withTimeout } from './with-timeout';

interface SafeEvaluateOptions {
  timeoutMs?: number;  // Default: 10000
  label?: string;      // For error messages, e.g. 'lightweight_scroll'
}

/**
 * Wrap page.evaluate with a per-call timeout.
 * Fails fast with descriptive error instead of waiting 30s for protocolTimeout.
 */
export async function safeEvaluate<T>(
  page: Page,
  fn: (...args: any[]) => T | Promise<T>,
  args: any[],
  options: SafeEvaluateOptions = {}
): Promise<T> {
  const { timeoutMs = 10000, label = 'evaluate' } = options;
  return withTimeout(
    page.evaluate(fn, ...args),
    timeoutMs,
    label
  );
}
