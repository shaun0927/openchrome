/**
 * Headed Chrome Fallback (#459)
 *
 * Manages a lazy-launched headed Chrome instance for Tier 3 fallback when
 * headless Chrome is blocked by CDN/WAF systems at the TLS/UA level.
 *
 * Architecture:
 * - Separate from the main headless Chrome (different port)
 * - Launched only when first needed (lazy)
 * - Reused across multiple fallback navigations
 * - Cleaned up on process exit
 */

import puppeteer, { Browser, Page } from 'puppeteer-core';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasDisplay } from '../utils/display-detect';
import { detectBlockingPage, BlockingInfo } from '../utils/page-diagnostics';
import { safeTitle } from '../utils/safe-title';
import { getTargetId } from '../utils/puppeteer-helpers';

/** Default port offset from main Chrome port for the headed fallback */
const HEADED_PORT_OFFSET = 100;

/** Navigate result from headed fallback */
export interface HeadedNavigateResult {
  url: string;
  title: string;
  elementCount: number;
  blockingPage: BlockingInfo | null;
}

/** Navigate result that keeps the page alive for session integration */
export interface HeadedPersistentResult extends HeadedNavigateResult {
  targetId: string;
}

/**
 * Find Chrome binary path (subset of launcher.ts findChromePath for independence)
 */
function findChromeBinary(): string | null {
  const envPath = process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const platform = os.platform();
  if (platform === 'darwin') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(p)) return p;
  } else if (platform === 'win32') {
    const envProgramFiles = process.env['PROGRAMFILES'];
    if (envProgramFiles) {
      const p = path.join(envProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  } else {
    for (const p of ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']) {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

class HeadedFallbackManager {
  private browser: Browser | null = null;
  private chromeProcess: ChildProcess | null = null;
  private launching: Promise<Browser> | null = null;
  private port: number;
  private alivePages: Map<string, Page> = new Map();
  private profileDirectory?: string;

  constructor(basePort: number = 9222) {
    this.port = basePort + HEADED_PORT_OFFSET;

    // Clean up on process exit
    const cleanup = () => this.shutdown();
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }

  /** Check if headed fallback is available in this environment */
  isAvailable(): boolean {
    return hasDisplay() && findChromeBinary() !== null;
  }

  /** Get the debug port for the headed Chrome instance */
  getPort(): number {
    return this.port;
  }

  /** Get or launch the headed Chrome browser */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;

    // Prevent concurrent launches
    if (this.launching) return this.launching;

    this.launching = this.launchHeadedChrome(this.profileDirectory);
    try {
      this.browser = await this.launching;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  private async launchHeadedChrome(profileDirectory?: string): Promise<Browser> {
    const chromePath = findChromeBinary();
    if (!chromePath) {
      throw new Error('[HeadedFallback] Chrome binary not found');
    }

    if (!hasDisplay()) {
      throw new Error('[HeadedFallback] No display available for headed Chrome');
    }

    // When profileDirectory is specified, use a persistent profile dir with cookie sync.
    // Otherwise, use a temp profile to avoid conflicting with the user's Chrome. (#562)
    let userDataDir: string;
    if (profileDirectory) {
      const safeName = profileDirectory.replace(/[^a-zA-Z0-9_\- ]/g, '_');
      userDataDir = path.join(os.homedir(), '.openchrome', 'profiles', safeName);

      // Sync cookies from real Chrome profile (non-fatal)
      try {
        const { ProfileManager } = await import('./profile-manager');
        const profileManager = new ProfileManager();
        const realProfileDir = profileManager.getDefaultUserDataDir();
        if (realProfileDir && profileManager.needsSync(realProfileDir, profileDirectory)) {
          const result = profileManager.syncProfileData(realProfileDir, userDataDir, profileDirectory);
          console.error(`[HeadedFallback] Cookie sync: atomic=${result.atomic}, success=${result.success}`);
        }
      } catch (err) {
        console.error('[HeadedFallback] Cookie sync failed (non-fatal):', err);
      }
    } else {
      userDataDir = path.join(os.tmpdir(), `openchrome-headed-fallback-${this.port}`);
    }
    fs.mkdirSync(userDataDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${userDataDir}`,
      ...(profileDirectory ? [`--profile-directory=${profileDirectory}`] : []),
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled',
    ];

    console.error(`[HeadedFallback] Launching headed Chrome on port ${this.port}...`);

    this.chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
    });
    this.chromeProcess.unref();

    // Wait for Chrome to be ready
    const wsEndpoint = await this.waitForDebugPort(15000);

    const browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: null,
    });

    console.error(`[HeadedFallback] Headed Chrome ready on port ${this.port}`);
    return browser;
  }

  private async waitForDebugPort(timeoutMs: number): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        const data = await response.json() as { webSocketDebuggerUrl?: string };
        if (data.webSocketDebuggerUrl) {
          return data.webSocketDebuggerUrl;
        }
      } catch {
        // Chrome not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`[HeadedFallback] Chrome did not start within ${timeoutMs}ms`);
  }

  /**
   * Navigate to a URL in the headed Chrome fallback (one-shot, closes page).
   * Use navigatePersistent() when you need to keep the page alive for tool interaction.
   */
  async navigate(url: string): Promise<HeadedNavigateResult> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Wait a moment for any JS to execute
      await new Promise(resolve => setTimeout(resolve, 2000));

      const [title, elementCount, blocking] = await Promise.all([
        safeTitle(page as unknown as Page),
        page.evaluate(() => document.querySelectorAll('*').length).catch(() => 0),
        detectBlockingPage(page as unknown as Page).catch(() => null),
      ]);

      return {
        url: page.url(),
        title,
        elementCount,
        blockingPage: blocking,
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Navigate to a URL and keep the page alive for session manager integration.
   * The page remains open so tools (read_page, interact, screenshot) can use it
   * via the session manager's headed worker. (#485)
   *
   * When profileDirectory is provided, the headed Chrome is launched with that
   * profile and cookies are synced from the real Chrome installation. (#562)
   */
  async navigatePersistent(url: string, profileDirectory?: string): Promise<HeadedPersistentResult> {
    // If a different profile is requested than what the browser was launched with,
    // shut down and relaunch with the new profile. (#562)
    if (profileDirectory !== this.profileDirectory && this.browser) {
      console.error(`[HeadedFallback] Profile changed from "${this.profileDirectory ?? '(none)'}" to "${profileDirectory ?? '(none)'}", restarting browser`);
      this.shutdown();
    }
    this.profileDirectory = profileDirectory;
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Wait a moment for any JS to execute
      await new Promise(resolve => setTimeout(resolve, 2000));

      const [title, elementCount, blocking] = await Promise.all([
        safeTitle(page as unknown as Page),
        page.evaluate(() => document.querySelectorAll('*').length).catch(() => 0),
        detectBlockingPage(page as unknown as Page).catch(() => null),
      ]);

      const targetId = getTargetId(page.target());
      this.alivePages.set(targetId, page as unknown as Page);
      page.once('close', () => this.alivePages.delete(targetId));

      return {
        targetId,
        url: page.url(),
        title,
        elementCount,
        blockingPage: blocking,
      };
    } catch (err) {
      await page.close().catch(() => {});
      throw err;
    }
  }

  /** Get a kept-alive page by its target ID. Returns null if not found. (#485) */
  getPage(targetId: string): Page | null {
    return this.alivePages.get(targetId) ?? null;
  }

  /** Shut down the headed Chrome instance */
  shutdown(): void {
    // Close any kept-alive pages
    for (const [, page] of this.alivePages) {
      try { page.close().catch(() => {}); } catch { /* ignore */ }
    }
    this.alivePages.clear();

    if (this.browser) {
      try { this.browser.disconnect(); } catch { /* ignore */ }
      this.browser = null;
    }
    if (this.chromeProcess && this.chromeProcess.exitCode === null) {
      try { this.chromeProcess.kill(); } catch { /* ignore */ }
      this.chromeProcess = null;
    }
  }
}

// Singleton instance — port is set on first use
let instance: HeadedFallbackManager | null = null;

export function getHeadedFallback(basePort: number = 9222): HeadedFallbackManager {
  if (!instance) {
    instance = new HeadedFallbackManager(basePort);
  }
  return instance;
}

/** Shut down the headed fallback if it was ever initialized. Safe to call unconditionally. */
export function shutdownHeadedFallback(): void {
  if (instance) {
    instance.shutdown();
    instance = null;
  }
}
