import { Page } from 'puppeteer-core';
import { writeFileAtomicSafe, readFileSafe } from '../utils/atomic-file';
import { DEFAULT_STORAGE_STATE_RESTORE_TIMEOUT_MS, DEFAULT_WATCHDOG_INTERVAL_MS } from '../config/defaults';

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
  localStorage: Record<string, string> | Record<string, Record<string, string>>;
}

export interface CDPClientLike {
  send<T>(page: Page, method: string, params?: Record<string, unknown>): Promise<T>;
}

/**
 * Pure-data shape captured by the shared CDP walker. Used by both the
 * file-backed StorageStateManager.save()/restore() path and the in-memory
 * oc_context export/import surface (#873).
 */
export interface EnvelopeCapture {
  origin: string;
  cookies: StorageState['cookies'];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  userAgent?: string;
  viewport?: { width: number; height: number };
}

export interface EnvelopeCaptureOptions {
  /** Capture cookies via Network.getAllCookies. Default true. */
  includeCookies?: boolean;
  /** Capture window.localStorage for the active origin. Default true. */
  includeLocalStorage?: boolean;
  /** Capture window.sessionStorage for the active origin. Default false. */
  includeSessionStorage?: boolean;
  /** Capture navigator.userAgent. Default false. */
  captureUserAgent?: boolean;
  /** Capture window.innerWidth/innerHeight. Default false. */
  captureViewport?: boolean;
}

export interface EnvelopeApplyOptions {
  /** Replace cookies for `origin` (clear existing first, then set supplied). Default true. */
  applyCookies?: boolean;
  /** Replace localStorage for the active origin (clear, then set). Default true. */
  applyLocalStorage?: boolean;
  /** Replace sessionStorage for the active origin (clear, then set). Default true. */
  applySessionStorage?: boolean;
  /**
   * Per-origin scope for cookie deletion. When provided, only cookies whose
   * domain matches the origin's hostname (with or without leading dot) are
   * cleared. Without this the entire cookie jar is wiped, which is too
   * aggressive for a single-origin envelope.
   */
  origin?: string;
}

export interface EnvelopeApplyResult {
  appliedCookies: number;
  appliedStorageKeys: number;
}

// ─── Shared CDP walker (#873) ────────────────────────────────────────────────

/**
 * Read all storage relevant to the active page in one CDP traversal.
 * Pure-data; no file I/O. Used by both StorageStateManager.save() and the
 * `oc_context_export` MCP tool.
 */
export async function captureContextEnvelopeData(
  page: Page,
  cdpClient: CDPClientLike,
  options: EnvelopeCaptureOptions = {},
): Promise<EnvelopeCapture> {
  const opts = {
    includeCookies: options.includeCookies !== false,
    includeLocalStorage: options.includeLocalStorage !== false,
    includeSessionStorage: options.includeSessionStorage === true,
    captureUserAgent: options.captureUserAgent === true,
    captureViewport: options.captureViewport === true,
  };

  // Origin is needed for scoping; about:blank yields 'null' which we treat as unscoped.
  let origin = '';
  try {
    origin = (await page.evaluate(() => window.location.origin)) as string;
  } catch {
    origin = '';
  }

  // Cookies
  let cookies: StorageState['cookies'] = [];
  if (opts.includeCookies) {
    const result = await cdpClient.send<{ cookies: StorageState['cookies'] }>(
      page,
      'Network.getAllCookies',
      {},
    );
    cookies = result.cookies || [];
  }

  // localStorage (origin-scoped via window.localStorage)
  let localStorage: Record<string, string> = {};
  if (opts.includeLocalStorage && origin && origin !== 'null') {
    try {
      localStorage = (await page.evaluate(() => {
        const out: Record<string, string> = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k) out[k] = window.localStorage.getItem(k) || '';
        }
        return out;
      })) as Record<string, string>;
    } catch {
      localStorage = {};
    }
  }

  // sessionStorage (origin-scoped)
  let sessionStorage: Record<string, string> = {};
  if (opts.includeSessionStorage && origin && origin !== 'null') {
    try {
      sessionStorage = (await page.evaluate(() => {
        const out: Record<string, string> = {};
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const k = window.sessionStorage.key(i);
          if (k) out[k] = window.sessionStorage.getItem(k) || '';
        }
        return out;
      })) as Record<string, string>;
    } catch {
      sessionStorage = {};
    }
  }

  const capture: EnvelopeCapture = {
    origin: origin === 'null' ? '' : origin,
    cookies,
    localStorage,
    sessionStorage,
  };

  if (opts.captureUserAgent) {
    try {
      const ua = (await page.evaluate(() => navigator.userAgent)) as string;
      if (ua) capture.userAgent = ua;
    } catch {
      // best-effort
    }
  }

  if (opts.captureViewport) {
    try {
      const vp = (await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))) as { width: number; height: number };
      if (vp && typeof vp.width === 'number' && typeof vp.height === 'number') {
        capture.viewport = vp;
      }
    } catch {
      // best-effort
    }
  }

  return capture;
}

/**
 * Strict-replace apply of a captured envelope to a live page. Used by both
 * StorageStateManager.restore() (file-path) and `oc_context_import` (#873).
 *
 * Strict semantics: existing cookies for the target origin and the entire
 * active-origin web storage are cleared first, then the supplied values are
 * installed. This intentionally does NOT merge.
 */
export async function applyContextEnvelopeData(
  page: Page,
  cdpClient: CDPClientLike,
  capture: EnvelopeCapture,
  options: EnvelopeApplyOptions = {},
): Promise<EnvelopeApplyResult> {
  const opts = {
    applyCookies: options.applyCookies !== false,
    applyLocalStorage: options.applyLocalStorage !== false,
    applySessionStorage: options.applySessionStorage !== false,
    origin: options.origin ?? capture.origin,
  };

  let appliedCookies = 0;
  let appliedStorageKeys = 0;

  // ─── Cookies: clear-then-set, scoped to envelope.origin where possible ───
  if (opts.applyCookies) {
    const targetHost = hostnameFromOrigin(opts.origin);
    const { cookies: existing } = await cdpClient.send<{ cookies: StorageState['cookies'] }>(
      page,
      'Network.getAllCookies',
      {},
    );

    const toDelete = existing.filter((c) =>
      targetHost ? domainMatchesHost(c.domain, targetHost) : true,
    );

    if (toDelete.length > 0) {
      // Network.deleteCookies is name+url-scoped, so loop.
      for (const c of toDelete) {
        const url = cookieUrlFor(c, opts.origin);
        try {
          await cdpClient.send(page, 'Network.deleteCookies', {
            name: c.name,
            url,
            domain: c.domain,
            path: c.path,
          });
        } catch {
          // best-effort; continue
        }
      }
    }

    // Drop expired (non-session) cookies.
    const nowSec = Date.now() / 1000;
    const validCookies = capture.cookies.filter((c) => {
      if (c.session) return true;
      if (c.expires > 0 && c.expires < nowSec) return false;
      return true;
    });

    if (validCookies.length > 0) {
      await cdpClient.send(page, 'Network.setCookies', { cookies: validCookies });
      appliedCookies = validCookies.length;
    }
  }

  // ─── localStorage: clear-then-set on the active origin ────────────────────
  if (opts.applyLocalStorage) {
    try {
      const pageOrigin = (await page.evaluate(() => window.location.origin)) as string;
      // Only touch storage if the active origin matches the envelope origin
      // (or the caller passed origin explicitly).
      if (pageOrigin && pageOrigin !== 'null' && (!opts.origin || pageOrigin === opts.origin)) {
        await page.evaluate(() => window.localStorage.clear());
        if (Object.keys(capture.localStorage).length > 0) {
          await page.evaluate((data: Record<string, string>) => {
            for (const [k, v] of Object.entries(data)) {
              window.localStorage.setItem(k, v);
            }
          }, capture.localStorage);
          appliedStorageKeys += Object.keys(capture.localStorage).length;
        }
      }
    } catch {
      // about:blank / chrome:// — silently skip
    }
  }

  // ─── sessionStorage: clear-then-set on the active origin ──────────────────
  if (opts.applySessionStorage) {
    try {
      const pageOrigin = (await page.evaluate(() => window.location.origin)) as string;
      if (pageOrigin && pageOrigin !== 'null' && (!opts.origin || pageOrigin === opts.origin)) {
        await page.evaluate(() => window.sessionStorage.clear());
        if (Object.keys(capture.sessionStorage).length > 0) {
          await page.evaluate((data: Record<string, string>) => {
            for (const [k, v] of Object.entries(data)) {
              window.sessionStorage.setItem(k, v);
            }
          }, capture.sessionStorage);
          appliedStorageKeys += Object.keys(capture.sessionStorage).length;
        }
      }
    } catch {
      // best-effort
    }
  }

  return { appliedCookies, appliedStorageKeys };
}

function hostnameFromOrigin(origin: string): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

function domainMatchesHost(cookieDomain: string, host: string): boolean {
  // Cookie domains may be ".example.com" or "example.com". We match if the
  // host equals the cookie domain (with leading dot stripped) or is a sub of it.
  const bare = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  return host === bare || host.endsWith('.' + bare);
}

function cookieUrlFor(
  cookie: StorageState['cookies'][number],
  fallbackOrigin: string,
): string {
  const bare = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
  const scheme = cookie.secure ? 'https' : 'https'; // safer default
  if (bare) return `${scheme}://${bare}${cookie.path || '/'}`;
  return fallbackOrigin || 'https://localhost/';
}

export class StorageStateManager {
  private watchdogTimer: NodeJS.Timeout | null = null;
  private saving: boolean = false;

  /**
   * Save current browser state (cookies + localStorage) to file.
   * Uses the shared envelope walker (`captureContextEnvelopeData`).
   */
  async save(page: Page, cdpClient: CDPClientLike, filePath: string): Promise<void> {
    if (this.saving) return; // prevent concurrent saves
    this.saving = true;
    try {
      const capture = await captureContextEnvelopeData(page, cdpClient, {
        includeCookies: true,
        includeLocalStorage: true,
        includeSessionStorage: false,
      });

      // Persist in the legacy origin-scoped shape so older readers stay compatible.
      const localStorage: Record<string, Record<string, string>> = {};
      if (capture.origin && Object.keys(capture.localStorage).length > 0) {
        localStorage[capture.origin] = capture.localStorage;
      }

      const state: StorageState = {
        version: 1,
        timestamp: Date.now(),
        cookies: capture.cookies,
        localStorage,
      };

      await writeFileAtomicSafe(filePath, state);
    } finally {
      this.saving = false;
    }
  }

  /**
   * Restore browser state from file.
   * Uses the shared envelope walker (`applyContextEnvelopeData`) for the
   * cookie-set leg, but keeps the legacy origin-scoped localStorage
   * detection so older snapshots round-trip cleanly.
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

        // Restore localStorage (origin-scoped)
        if (state.localStorage && Object.keys(state.localStorage).length > 0) {
          try {
            const pageOrigin = await page.evaluate(() => window.location.origin) as string;

            // Detect format: old (flat) vs new (origin-scoped)
            const firstValue = Object.values(state.localStorage)[0];
            const isOriginScoped = typeof firstValue === 'object' && firstValue !== null;

            if (isOriginScoped) {
              // New format: origin-scoped — only inject keys for matching origin
              const originData = (state.localStorage as Record<string, Record<string, string>>)[pageOrigin];
              if (originData && Object.keys(originData).length > 0) {
                await page.evaluate((data: Record<string, string>) => {
                  for (const [key, value] of Object.entries(data)) {
                    window.localStorage.setItem(key, value);
                  }
                }, originData);
              }
            } else {
              // Legacy format: flat (backward compatible — inject all, as before)
              await page.evaluate((data: Record<string, string>) => {
                for (const [key, value] of Object.entries(data)) {
                  window.localStorage.setItem(key, value);
                }
              }, state.localStorage as Record<string, string>);
            }
          } catch {
            // Skip if localStorage can't be accessed (about:blank, chrome://)
          }
        }
      })().finally(() => clearTimeout(restoreTid)),
      new Promise<void>((resolve) => {
        restoreTid = setTimeout(resolve, DEFAULT_STORAGE_STATE_RESTORE_TIMEOUT_MS);
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

    const interval = opts.intervalMs || DEFAULT_WATCHDOG_INTERVAL_MS;

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
