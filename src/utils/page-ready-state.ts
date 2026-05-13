import type { Page } from 'puppeteer-core';
import type { ToolContext } from '../types/mcp';
import { getRemainingBudget } from '../types/mcp';
import { isTimeoutError } from '../errors/timeout';
import { withTimeout } from './with-timeout';

export interface PageReadyOptions {
  /** Maximum wall-clock wait in ms. Default: 5000. */
  timeoutMs?: number;
  /** Required quiet window after the last visible DOM mutation. Default: 250. */
  quietWindowMs?: number;
}

export interface PageReadyResult {
  ready: boolean;
  timedOut: boolean;
  elapsedMs: number;
  readyState?: string;
  mutationsObserved?: number;
  warning?: string;
}

interface ProbeOptions {
  timeoutMs: number;
  quietWindowMs: number;
}

const DEFAULT_READY_TIMEOUT_MS = 5000;
const DEFAULT_QUIET_WINDOW_MS = 250;
const MIN_READY_TIMEOUT_MS = 1;

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_READY_TIMEOUT_MS, Math.floor(value));
}

/**
 * Browser-context probe used by waitForPageReady(). Exported for deterministic
 * unit tests; keep dependencies limited to DOM globals available in page.evaluate.
 */
export function pageReadyProbe(options: ProbeOptions): Promise<Omit<PageReadyResult, 'elapsedMs'>> {
  const timeoutMs = Math.max(MIN_READY_TIMEOUT_MS, Math.floor(options.timeoutMs));
  const quietWindowMs = Math.max(0, Math.floor(options.quietWindowMs));

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let mutationsObserved = 0;
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: MutationObserver | null = null;
    let readyStateListener: (() => void) | null = null;

    const cleanup = () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (observer) observer.disconnect();
      if (readyStateListener && typeof document !== 'undefined') {
        document.removeEventListener('readystatechange', readyStateListener);
      }
      quietTimer = null;
      timeoutTimer = null;
      observer = null;
      readyStateListener = null;
    };

    const finish = (ready: boolean, timedOut: boolean, warning?: string) => {
      if (settled) return;
      settled = true;
      const readyState = typeof document !== 'undefined' ? document.readyState : 'unknown';
      cleanup();
      resolve({
        ready,
        timedOut,
        readyState,
        mutationsObserved,
        ...(warning ? { warning } : {}),
      });
    };

    const armQuietTimer = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true, false), quietWindowMs);
    };

    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !doc.documentElement) {
      finish(false, false, 'document is not available');
      return;
    }

    timeoutTimer = setTimeout(() => {
      finish(false, true, `page readiness timed out after ${Date.now() - startedAt}ms`);
    }, timeoutMs);

    const startObserving = () => {
      try {
        observer = new MutationObserver((records) => {
          const hasVisibleDomMutation = records.some((record) =>
            record.type === 'childList' || record.type === 'attributes' || record.type === 'characterData'
          );
          if (hasVisibleDomMutation) {
            mutationsObserved++;
            armQuietTimer();
          }
        });
        observer.observe(doc.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      } catch (error) {
        finish(false, false, `failed to observe DOM mutations: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      armQuietTimer();
    };

    if (doc.readyState === 'interactive' || doc.readyState === 'complete') {
      startObserving();
      return;
    }

    const onReadyState = () => {
      if (doc.readyState === 'interactive' || doc.readyState === 'complete') {
        doc.removeEventListener('readystatechange', onReadyState);
        readyStateListener = null;
        startObserving();
      }
    };
    readyStateListener = onReadyState;
    doc.addEventListener('readystatechange', onReadyState);
  });
}

export async function waitForPageReady(
  page: Page,
  options: PageReadyOptions = {},
  context?: ToolContext,
): Promise<PageReadyResult> {
  const startedAt = Date.now();
  const requestedTimeoutMs = normalizePositiveInt(options.timeoutMs, DEFAULT_READY_TIMEOUT_MS);
  const quietWindowMs = normalizePositiveInt(options.quietWindowMs, DEFAULT_QUIET_WINDOW_MS);
  const budgetMs = context ? Math.max(MIN_READY_TIMEOUT_MS, getRemainingBudget(context) - 100) : requestedTimeoutMs;
  const timeoutMs = Math.max(MIN_READY_TIMEOUT_MS, Math.min(requestedTimeoutMs, budgetMs));

  try {
    const result = await withTimeout(
      page.evaluate(pageReadyProbe, { timeoutMs, quietWindowMs }),
      timeoutMs + 100,
      'page_ready',
      context,
    );
    return { ...result, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isTimeoutError(error)) {
      return {
        ready: false,
        timedOut: true,
        elapsedMs: Date.now() - startedAt,
        warning: message,
      };
    }
    if (context?.signal?.aborted) {
      throw error;
    }
    return {
      ready: false,
      timedOut: false,
      elapsedMs: Date.now() - startedAt,
      warning: `page readiness probe failed: ${message}`,
    };
  }
}
