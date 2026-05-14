import type { Page } from 'puppeteer-core';
import type { EvalContext, NetworkLogEntry } from './eval-context';
import type { NetworkSinceMarker } from './types';

export interface ChromeEvalContextOptions {
  /** Optional bounded network entries captured by the caller/runtime. */
  networkEntries?: NetworkLogEntry[];
  /** Optional marker timestamps used to filter network entries. */
  networkMarkers?: Partial<Record<NetworkSinceMarker, number>>;
  /** Optional persisted screenshot path for evidence enrichment. */
  screenshotPath?: string;
  /** Optional trace window for evidence enrichment. */
  traceWindow?: { trace_id: string; from_ts: number; to_ts: number };
  /** Screenshot timeout in milliseconds. Defaults to 5000. */
  screenshotTimeoutMs?: number;
}

/**
 * Build an EvalContext from a live Puppeteer/CDP page.
 *
 * This is intentionally narrow: contract evaluators get URL/text/count/network/
 * screenshot/dialog facts without depending on OpenChrome tool handlers or MCP
 * response shapes. It unblocks real-Chrome critical-contract e2e tests (#733)
 * while keeping the contracts module unit-testable through EvalContext.
 */
export function createChromeEvalContext(
  page: Pick<Page, 'url' | 'evaluate' | 'screenshot'>,
  opts: ChromeEvalContextOptions = {},
): EvalContext {
  return {
    async url(): Promise<string> {
      return page.url() || 'about:blank';
    },

    async domText(selector?: string): Promise<string | null> {
      return page.evaluate((sel?: string) => {
        const node = sel ? document.querySelector(sel) : document.body;
        if (!node) return null;
        return (node as HTMLElement).innerText ?? node.textContent ?? '';
      }, selector);
    },

    async domCount(selector: string): Promise<number> {
      return page.evaluate((sel: string) => document.querySelectorAll(sel).length, selector);
    },

    async networkSince(marker: NetworkSinceMarker): Promise<NetworkLogEntry[]> {
      const since = opts.networkMarkers?.[marker] ?? 0;
      return (opts.networkEntries ?? []).filter((entry) => entry.ts >= since);
    },

    async screenshotPng(): Promise<Buffer | null> {
      try {
        const shot = await withTimeout(
          Promise.resolve(page.screenshot({ type: 'png' }) as Promise<Buffer | string | Uint8Array>),
          opts.screenshotTimeoutMs ?? 5000,
        );
        if (Buffer.isBuffer(shot)) return shot;
        if (typeof shot === 'string') return Buffer.from(shot, 'base64');
        return Buffer.from(shot);
      } catch {
        return null;
      }
    },

    async hasOpenDialog(): Promise<boolean> {
      // Puppeteer does not expose a safe synchronous dialog-open query. Runtime
      // code that tracks dialog events can provide a richer context later; this
      // adapter keeps the default conservative and side-effect free.
      return false;
    },

    async screenshotPath(): Promise<string | undefined> {
      return opts.screenshotPath;
    },

    async traceWindow(): Promise<{ trace_id: string; from_ts: number; to_ts: number } | undefined> {
      return opts.traceWindow;
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`chrome_eval_context_timeout_${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer);
    });
  });
}
