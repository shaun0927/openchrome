import type { Page, Cookie, CookieParam } from 'puppeteer-core';

export interface CookieSyncConfig {
  /** Interval between periodic syncs in milliseconds. Default: 5000 */
  intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 5000;

/**
 * CookieSync handles bidirectional cookie synchronisation between Chrome and
 * Lightpanda pages. All operations are best-effort – errors are caught and
 * logged but never thrown so callers are not disrupted.
 */
export class CookieSync {
  private syncTimer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(config?: Partial<CookieSyncConfig>) {
    this.intervalMs = config?.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * Core sync primitive. Reads cookies from `source`, optionally filters by
   * `domain`, then writes them to `target`.
   *
   * @returns Number of cookies actually synced, or 0 on error.
   */
  async syncCookies(source: Page, target: Page, domain?: string): Promise<number> {
    try {
      let cookies = await source.cookies();

      if (domain) {
        cookies = cookies.filter((c) => c.domain === domain || c.domain === `.${domain}`);
      }

      if (cookies.length === 0) {
        return 0;
      }

      await target.setCookie(...(cookies as CookieParam[]));
      return cookies.length;
    } catch (err) {
      console.error('[CookieSync] syncCookies error:', err);
      return 0;
    }
  }

  /**
   * Sync cookies from Chrome to Lightpanda (e.g. before delegating a task).
   */
  async chromeToLightpanda(
    chromePage: Page,
    lightpandaPage: Page,
    domain?: string,
  ): Promise<number> {
    return this.syncCookies(chromePage, lightpandaPage, domain);
  }

  /**
   * Sync cookies from Lightpanda back to Chrome on escalation.
   * Uses a MERGE strategy – only cookies not already present in Chrome are
   * added; existing Chrome cookies are never overwritten.
   *
   * @returns Number of new cookies added to Chrome.
   */
  async lightpandaToChrome(lightpandaPage: Page, chromePage: Page): Promise<number> {
    try {
      const [lpCookies, chromeCookies] = await Promise.all([
        lightpandaPage.cookies(),
        chromePage.cookies(),
      ]);

      // Build a set of existing Chrome cookie keys for fast lookup
      const existingKeys = new Set(
        chromeCookies.map((c) => `${c.name}::${c.domain}::${c.path}`),
      );

      const newCookies = lpCookies.filter(
        (c) => !existingKeys.has(`${c.name}::${c.domain}::${c.path}`),
      );

      if (newCookies.length === 0) {
        return 0;
      }

      await chromePage.setCookie(...(newCookies as CookieParam[]));
      return newCookies.length;
    } catch (err) {
      console.error('[CookieSync] lightpandaToChrome error:', err);
      return 0;
    }
  }

  /**
   * Start a periodic background sync from `source` to `target`.
   * The timer is unref'd so it will not prevent process exit.
   */
  startPeriodicSync(source: Page, target: Page, domain?: string): void {
    this.stopPeriodicSync();

    const timer = setInterval(() => {
      this.syncCookies(source, target, domain).catch((err) => {
        console.error('[CookieSync] periodic sync error:', err);
      });
    }, this.intervalMs);

    // Do not block process exit
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.syncTimer = timer;
  }

  /**
   * Stop the periodic sync timer if one is running.
   */
  stopPeriodicSync(): void {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Alias for stopPeriodicSync – stops the timer and releases resources.
   */
  cleanup(): void {
    this.stopPeriodicSync();
  }
}
