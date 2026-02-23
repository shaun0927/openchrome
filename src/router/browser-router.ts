import type { Page } from 'puppeteer-core';
import {
  BrowserBackend,
  HybridConfig,
  RouterStats,
  EscalationResult,
} from '../types/browser-backend';
import { ToolRoutingRegistry } from './tool-routing-registry';
import { LightpandaLauncher } from '../lightpanda/launcher';
import { CookieSync } from './cookie-sync';

export interface RouteResult {
  backend: BrowserBackend;
  page: Page;
  fallback: boolean;
}

export class BrowserRouter {
  private config: HybridConfig;
  private launcher: LightpandaLauncher | null = null;
  private cookieSync: CookieSync;
  private stats: RouterStats;

  // Circuit breaker state
  private consecutiveFailures: number = 0;
  private circuitOpen: boolean = false;
  private circuitOpenedAt: number = 0;

  constructor(config: HybridConfig) {
    this.config = config;
    this.cookieSync = new CookieSync({ intervalMs: config.cookieSync.intervalMs });
    this.stats = {
      chromeRequests: 0,
      lightpandaRequests: 0,
      fallbacks: 0,
      circuitBreakerTrips: 0,
    };
  }

  /**
   * Route a tool request to the appropriate backend.
   *
   * Decision order:
   * 1. Hybrid disabled → always Chrome
   * 2. Visual tool → always Chrome
   * 3. Circuit breaker open and cooldown not expired → Chrome (increment circuitBreakerTrips)
   * 4. Circuit breaker open and cooldown expired → reset, try LP
   * 5. LP page provided and page is healthy → LP
   * 6. LP page missing or unhealthy → fallback to Chrome, record failure
   */
  async route(
    toolName: string,
    chromePage: Page,
    lightpandaPage?: Page | null,
  ): Promise<RouteResult> {
    // 1. Hybrid disabled
    if (!this.config.enabled) {
      this.stats.chromeRequests++;
      return { backend: BrowserBackend.CHROME, page: chromePage, fallback: false };
    }

    // 2. Visual tool always goes to Chrome
    if (ToolRoutingRegistry.isVisualTool(toolName)) {
      this.stats.chromeRequests++;
      return { backend: BrowserBackend.CHROME, page: chromePage, fallback: false };
    }

    // 3 & 4. Check circuit breaker
    if (this.circuitOpen) {
      const cooldownExpired =
        Date.now() - this.circuitOpenedAt >= this.config.circuitBreaker.cooldownMs;

      if (!cooldownExpired) {
        // Circuit still open → serve from Chrome
        this.stats.chromeRequests++;
        this.stats.circuitBreakerTrips++;
        return { backend: BrowserBackend.CHROME, page: chromePage, fallback: false };
      }

      // Cooldown expired → reset circuit and allow LP attempt
      this.circuitOpen = false;
      this.consecutiveFailures = 0;
    }

    // 5. Attempt Lightpanda
    if (lightpandaPage != null) {
      let pageHealthy = false;
      try {
        pageHealthy = !lightpandaPage.isClosed();
      } catch {
        // isClosed() threw → page is not usable
        pageHealthy = false;
      }

      if (pageHealthy) {
        this.stats.lightpandaRequests++;
        this.recordSuccess();
        return { backend: BrowserBackend.LIGHTPANDA, page: lightpandaPage, fallback: false };
      }
    }

    // 6. Fallback to Chrome
    this.stats.chromeRequests++;
    this.stats.fallbacks++;
    this.recordFailure();
    return { backend: BrowserBackend.CHROME, page: chromePage, fallback: true };
  }

  /**
   * Escalate from Lightpanda to Chrome.
   * - Gets current URL from LP page
   * - Syncs cookies LP → Chrome
   * - Navigates Chrome to same URL
   */
  async escalate(lightpandaPage: Page, chromePage: Page): Promise<EscalationResult> {
    const url = lightpandaPage.url();

    let cookiesSynced = false;
    try {
      const count = await this.cookieSync.lightpandaToChrome(lightpandaPage, chromePage);
      cookiesSynced = count >= 0; // lightpandaToChrome returns count (0 is still "synced" successfully)
    } catch {
      cookiesSynced = false;
    }

    try {
      await chromePage.goto(url);
    } catch {
      // best-effort navigation
    }

    return {
      success: true,
      previousBackend: BrowserBackend.LIGHTPANDA,
      newBackend: BrowserBackend.CHROME,
      cookiesSynced,
      url,
    };
  }

  /** Get routing statistics */
  getStats(): RouterStats {
    return { ...this.stats };
  }

  /** Reset statistics */
  resetStats(): void {
    this.stats = {
      chromeRequests: 0,
      lightpandaRequests: 0,
      fallbacks: 0,
      circuitBreakerTrips: 0,
    };
  }

  /** Check if circuit breaker is currently open */
  isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  /** Initialize launcher and connect to Lightpanda */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    this.launcher = new LightpandaLauncher({
      port: this.config.lightpandaPort,
    });

    await this.launcher.start();
    await this.launcher.connect();
  }

  /** Cleanup resources */
  async cleanup(): Promise<void> {
    this.cookieSync.cleanup();

    if (this.launcher) {
      await this.launcher.disconnect();
      await this.launcher.stop();
      this.launcher = null;
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;

    if (
      !this.circuitOpen &&
      this.consecutiveFailures >= this.config.circuitBreaker.maxFailures
    ) {
      this.circuitOpen = true;
      this.circuitOpenedAt = Date.now();
    }
  }

  /** Returns true if the circuit breaker should cause LP to be skipped */
  private checkCircuitBreaker(): boolean {
    if (!this.circuitOpen) {
      return false;
    }

    const cooldownExpired =
      Date.now() - this.circuitOpenedAt >= this.config.circuitBreaker.cooldownMs;

    if (cooldownExpired) {
      this.circuitOpen = false;
      this.consecutiveFailures = 0;
      return false;
    }

    return true;
  }
}
