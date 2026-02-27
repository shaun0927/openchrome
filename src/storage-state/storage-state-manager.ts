import { Page } from 'puppeteer-core';
import { writeFileAtomicSafe, readFileSafe } from '../utils/atomic-file';

export interface StorageState {
  version: 1;
  timestamp: number;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    size: number;
    httpOnly: boolean;
    secure: boolean;
    session: boolean;
    sameSite?: string;
  }>;
  localStorage: Record<string, string>;
}

export interface CDPClientLike {
  send<T>(page: Page, method: string, params?: Record<string, unknown>): Promise<T>;
}

export class StorageStateManager {
  private watchdogTimer: NodeJS.Timeout | null = null;
  private saving: boolean = false;

  /**
   * Save current browser state (cookies + localStorage) to file.
   * Uses Network.getAllCookies + page.evaluate for localStorage.
   */
  async save(page: Page, cdpClient: CDPClientLike, filePath: string): Promise<void> {
    if (this.saving) return; // prevent concurrent saves
    this.saving = true;
    try {
      // Get all cookies via CDP
      const { cookies } = await cdpClient.send<{ cookies: StorageState['cookies'] }>(
        page, 'Network.getAllCookies', {}
      );

      // Get localStorage via page.evaluate
      let localStorage: Record<string, string> = {};
      try {
        localStorage = await page.evaluate(() => {
          const result: Record<string, string> = {};
          for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);
            if (key) {
              result[key] = window.localStorage.getItem(key) || '';
            }
          }
          return result;
        }) as Record<string, string>;
      } catch {
        // localStorage may not be available (about:blank, chrome://)
        localStorage = {};
      }

      const state: StorageState = {
        version: 1,
        timestamp: Date.now(),
        cookies,
        localStorage,
      };

      await writeFileAtomicSafe(filePath, state);
    } finally {
      this.saving = false;
    }
  }

  /**
   * Restore browser state from file.
   * Uses Network.setCookies + page.evaluate to inject localStorage.
   */
  async restore(page: Page, cdpClient: CDPClientLike, filePath: string): Promise<boolean> {
    const result = await readFileSafe<StorageState>(filePath);
    if (!result.success || !result.data) {
      return false; // File missing or corrupted — silently skip
    }

    const state = result.data;

    // Validate version
    if (state.version !== 1) {
      return false;
    }

    let restoreTid: ReturnType<typeof setTimeout>;
    await Promise.race([
      (async () => {
        // Restore cookies
        if (state.cookies && state.cookies.length > 0) {
          // Filter out expired session cookies but keep persistent ones
          const validCookies = state.cookies.filter(c => {
            if (c.session) return true; // session cookies are always valid
            if (c.expires > 0 && c.expires < Date.now() / 1000) return false; // expired
            return true;
          });

          if (validCookies.length > 0) {
            await cdpClient.send(page, 'Network.setCookies', { cookies: validCookies });
          }
        }

        // Restore localStorage
        if (state.localStorage && Object.keys(state.localStorage).length > 0) {
          try {
            await page.evaluate((data: Record<string, string>) => {
              for (const [key, value] of Object.entries(data)) {
                window.localStorage.setItem(key, value);
              }
            }, state.localStorage);
          } catch {
            // Skip if localStorage can't be accessed (about:blank, chrome://)
          }
        }
      })().finally(() => clearTimeout(restoreTid)),
      new Promise<void>((resolve) => {
        restoreTid = setTimeout(resolve, 10000);
      }),
    ]);

    return true;
  }

  /**
   * Start periodic auto-save watchdog.
   * Uses setInterval with .unref() so it doesn't prevent process exit.
   */
  startWatchdog(page: Page, cdpClient: CDPClientLike, opts: {
    intervalMs?: number;
    filePath: string;
  }): void {
    this.stopWatchdog(); // clear any existing watchdog

    const interval = opts.intervalMs || 30000;

    this.watchdogTimer = setInterval(async () => {
      try {
        await this.save(page, cdpClient, opts.filePath);
      } catch {
        // Best-effort: don't crash on save failures
      }
    }, interval);

    // .unref() prevents the timer from keeping the process alive
    this.watchdogTimer.unref();
  }

  /**
   * Stop the watchdog. Does NOT trigger a final save (caller should do that).
   */
  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * Check if watchdog is running.
   */
  isWatchdogRunning(): boolean {
    return this.watchdogTimer !== null;
  }
}
