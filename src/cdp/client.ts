/**
 * CDP Client - Wrapper around puppeteer-core for Chrome DevTools Protocol
 */

import puppeteer, { Browser, BrowserContext, Page, Target, CDPSession } from 'puppeteer-core';
import { getChromeLauncher } from '../chrome/launcher';
import { getGlobalConfig } from '../config/global';
import { smartGoto } from '../utils/smart-goto';
import {
  DEFAULT_VIEWPORT,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_PROTOCOL_TIMEOUT_MS,
  DEFAULT_COOKIE_SCAN_TIMEOUT_MS,
  DEFAULT_COOKIE_SCAN_PER_TARGET_TIMEOUT_MS,
  DEFAULT_COOKIE_SCAN_MAX_CANDIDATES,
  DEFAULT_COOKIE_COPY_TIMEOUT_MS,
  DEFAULT_NEW_PAGE_TIMEOUT_MS,
  DEFAULT_PAGE_CONFIG_TIMEOUT_MS,
  DEFAULT_PUPPETEER_CONNECT_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_PING_TIMEOUT_MS,
  DEFAULT_CONNECT_VERIFY_STALENESS_MS,
} from '../config/defaults';

// Cookie type shared across methods
type CookieEntry = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
};

export interface CDPClientOptions {
  port?: number;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  heartbeatIntervalMs?: number;
  /** If true, auto-launch Chrome when not running (default: false) */
  autoLaunch?: boolean;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface ConnectionEvent {
  type: 'connected' | 'disconnected' | 'reconnecting' | 'reconnected' | 'reconnect_failed';
  timestamp: number;
  attempt?: number;
  error?: string;
}

// Helper to get target ID (internal puppeteer property)
function getTargetId(target: Target): string {
  // Access the internal _targetId property
  return (target as unknown as { _targetId: string })._targetId;
}

export class CDPClient {
  private browser: Browser | null = null;
  private sessions: Map<string, CDPSession> = new Map();
  private port: number;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;
  private heartbeatIntervalMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private eventListeners: ((event: ConnectionEvent) => void)[] = [];
  private targetDestroyedListeners: ((targetId: string, page?: Page) => void)[] = [];
  private reconnectAttempts = 0;
  private consecutiveHeartbeatFailures = 0;
  private checkConnectionInFlight = false;
  private autoLaunch: boolean;
  private cookieSourceCache: Map<string, { targetId: string; timestamp: number }> = new Map();
  private cookieDataCache: Map<string, { cookies: CookieEntry[]; timestamp: number }> = new Map();
  private targetIdIndex: Map<string, Page> = new Map();
  private inFlightCookieScans: Map<string, Promise<string | null>> = new Map();
  /** Coalesces concurrent connect() calls — only one connectInternal() runs at a time. */
  private pendingConnect: Promise<void> | null = null;
  /** Timestamp of last successful connection verification (heartbeat or active probe). */
  private lastVerifiedAt = 0;
  private static readonly COOKIE_CACHE_TTL = 300000; // 5 minutes

  constructor(options: CDPClientOptions = {}) {
    const globalConfig = getGlobalConfig();
    this.port = options.port || globalConfig.port;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 3;
    this.reconnectDelayMs = options.reconnectDelayMs || 1000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 5000;
    // Use explicit option if provided, otherwise use global config
    this.autoLaunch = options.autoLaunch !== undefined ? options.autoLaunch : globalConfig.autoLaunch;
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Add connection event listener
   */
  addConnectionListener(listener: (event: ConnectionEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * Remove connection event listener
   */
  removeConnectionListener(listener: (event: ConnectionEvent) => void): void {
    const index = this.eventListeners.indexOf(listener);
    if (index !== -1) {
      this.eventListeners.splice(index, 1);
    }
  }

  /**
   * Add target destroyed listener
   */
  addTargetDestroyedListener(listener: (targetId: string, page?: Page) => void): void {
    this.targetDestroyedListeners.push(listener);
  }

  /**
   * Remove target destroyed listener
   */
  removeTargetDestroyedListener(listener: (targetId: string, page?: Page) => void): void {
    const index = this.targetDestroyedListeners.indexOf(listener);
    if (index !== -1) {
      this.targetDestroyedListeners.splice(index, 1);
    }
  }

  /**
   * Handle target destroyed event
   */
  private onTargetDestroyed(targetId: string): void {
    this.sessions.delete(targetId);
    // Clean up cookie source cache entries pointing to this target
    for (const [key, entry] of this.cookieSourceCache) {
      if (entry.targetId === targetId) {
        this.cookieSourceCache.delete(key);
      }
    }
    // Clean up cookie data cache for this target
    this.cookieDataCache.delete(targetId);
    // Look up page BEFORE deleting from index so listeners can use it
    const page = this.targetIdIndex.get(targetId);
    this.targetIdIndex.delete(targetId);
    for (const listener of this.targetDestroyedListeners) {
      try {
        listener(targetId, page);
      } catch (e) {
        console.error('[CDPClient] Target destroyed listener error:', e);
      }
    }
  }

  /**
   * Emit connection event
   */
  private emitConnectionEvent(event: ConnectionEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('[CDPClient] Event listener error:', e);
      }
    }
  }

  /**
   * Start heartbeat monitoring
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.checkConnection();
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stop heartbeat monitoring
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Check connection health.
   * Sends an active CDP probe (Browser.getVersion) to detect half-open WebSocket
   * connections that browser.isConnected() misses (e.g., after macOS sleep/wake).
   */
  private async checkConnection(): Promise<boolean> {
    if (!this.browser) {
      return false;
    }
    if (this.checkConnectionInFlight) {
      return true; // Prior check still in progress
    }
    this.checkConnectionInFlight = true;

    try {
      if (!this.browser.isConnected()) {
        console.error('[CDPClient] Heartbeat: Connection flag lost, attempting reconnect...');
        await this.handleDisconnect();
        return false;
      }

      // Active probe: round-trip CDP command to detect dead WebSocket connections.
      // browser.isConnected() only checks a local flag — half-open TCP connections
      // (macOS sleep/wake, Chrome crash) pass the flag check but hang on real commands.
      let pingTid: ReturnType<typeof setTimeout>;
      await Promise.race([
        this.browser.version().finally(() => clearTimeout(pingTid)),
        new Promise<never>((_, reject) => {
          pingTid = setTimeout(
            () => reject(new Error('heartbeat ping timeout')),
            DEFAULT_HEARTBEAT_PING_TIMEOUT_MS,
          );
        }),
      ]);
      this.lastVerifiedAt = Date.now();
      this.consecutiveHeartbeatFailures = 0;
      return true;
    } catch (error) {
      this.consecutiveHeartbeatFailures++;
      if (this.consecutiveHeartbeatFailures < 2) {
        // First failure: warn but don't disconnect. Chrome may be under heavy load.
        console.error(`[CDPClient] Heartbeat probe failed (strike ${this.consecutiveHeartbeatFailures}/2), will retry next interval:`, error);
        return true; // Report as healthy to avoid premature disconnect
      }
      // Two consecutive failures: connection is truly dead
      console.error(`[CDPClient] Heartbeat failed ${this.consecutiveHeartbeatFailures} times consecutively, disconnecting:`, error);
      this.consecutiveHeartbeatFailures = 0;
      await this.handleDisconnect();
      return false;
    } finally {
      this.checkConnectionInFlight = false;
    }
  }

  /**
   * Handle disconnection with automatic reconnection
   */
  private async handleDisconnect(): Promise<void> {
    if (this.connectionState === 'reconnecting' || this.connectionState === 'connecting') {
      return; // Already reconnecting or connecting
    }

    this.reconnectAttempts = 0; // Reset counter on each new disconnect event
    this.connectionState = 'reconnecting';
    this.emitConnectionEvent({
      type: 'disconnected',
      timestamp: Date.now(),
    });

    // Clear existing sessions and stale state
    this.sessions.clear();
    this.targetIdIndex.clear();
    this.inFlightCookieScans.clear();
    this.lastVerifiedAt = 0;

    // Remove old browser listeners before nulling reference
    if (this.browser) {
      this.browser.removeAllListeners('disconnected');
      this.browser.removeAllListeners('targetdestroyed');
    }
    this.browser = null;

    // Attempt reconnection
    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.error(`[CDPClient] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`);

      this.emitConnectionEvent({
        type: 'reconnecting',
        timestamp: Date.now(),
        attempt: this.reconnectAttempts,
      });

      try {
        await this.connectInternal();
        console.error('[CDPClient] Reconnection successful');
        this.reconnectAttempts = 0;
        this.emitConnectionEvent({
          type: 'reconnected',
          timestamp: Date.now(),
        });
        return;
      } catch (error) {
        console.error(`[CDPClient] Reconnect attempt ${this.reconnectAttempts} failed:`, error);

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          await new Promise(resolve => setTimeout(resolve, this.reconnectDelayMs));
        }
      }
    }

    // All attempts failed
    this.connectionState = 'disconnected';
    this.emitConnectionEvent({
      type: 'reconnect_failed',
      timestamp: Date.now(),
      error: `Failed after ${this.maxReconnectAttempts} attempts`,
    });

    console.error('[CDPClient] All reconnection attempts failed');
    this.reconnectAttempts = 0;
  }

  /**
   * Internal connect logic
   */
  private async connectInternal(): Promise<void> {
    const launcher = getChromeLauncher(this.port);
    const instance = await launcher.ensureChrome({ autoLaunch: this.autoLaunch });

    // Explicit timeout on puppeteer.connect() — protocolTimeout only covers CDP messages,
    // NOT the initial WebSocket handshake. Without this, a listening but unresponsive Chrome
    // can block for the OS TCP timeout (60-120s on macOS).
    let wsConnectTid: ReturnType<typeof setTimeout>;
    this.browser = await Promise.race([
      puppeteer.connect({
        browserWSEndpoint: instance.wsEndpoint,
        defaultViewport: null,
        protocolTimeout: DEFAULT_PROTOCOL_TIMEOUT_MS,
      }).finally(() => clearTimeout(wsConnectTid)),
      new Promise<never>((_, reject) => {
        wsConnectTid = setTimeout(
          () => reject(new Error(`puppeteer.connect() timed out after ${DEFAULT_PUPPETEER_CONNECT_TIMEOUT_MS}ms (WebSocket to ${instance.wsEndpoint})`)),
          DEFAULT_PUPPETEER_CONNECT_TIMEOUT_MS,
        );
      }),
    ]) as Browser;

    // Set up disconnect handler
    this.browser.on('disconnected', () => {
      console.error('[CDPClient] Browser disconnected');
      this.handleDisconnect().catch((err) => {
        console.error('[CDPClient] handleDisconnect failed:', err);
      });
    });

    // Set up target destroyed handler
    this.browser.on('targetdestroyed', (target) => {
      const targetId = getTargetId(target);
      console.error(`[CDPClient] Target destroyed: ${targetId}`);
      this.onTargetDestroyed(targetId);
    });

    // Note: We intentionally do NOT call target.page() in the targetcreated listener.
    // Eagerly calling target.page() on every new target can materialize Chrome's internal
    // targets (prerender, speculative navigation, new-tab-page) as visible about:blank
    // ghost tabs. OpenChrome-created pages are indexed directly in createPage() instead.
    // Non-OpenChrome pages are found via fallback scan in getPageByTargetId().

    this.connectionState = 'connected';
    this.emitConnectionEvent({
      type: 'connected',
      timestamp: Date.now(),
    });
  }

  /**
   * Connect to Chrome instance.
   * Uses promise coalescing: concurrent callers share a single connectInternal() call
   * instead of each independently opening a WebSocket (which would orphan event listeners
   * and heartbeat timers from the first connection).
   */
  async connect(): Promise<void> {
    if (this.browser && this.browser.isConnected()) {
      // Skip active probe if recently verified by heartbeat (avoids per-call overhead)
      if (Date.now() - this.lastVerifiedAt < DEFAULT_CONNECT_VERIFY_STALENESS_MS) {
        return;
      }

      // Active probe: lightweight CDP round-trip to detect dead WebSocket connections.
      // Replaces the previous ensureChrome() call which added 2-7s HTTP overhead.
      // browser.isConnected() only checks a local flag — half-open TCP connections
      // (macOS sleep/wake, Chrome crash) pass the flag check but hang on real commands.
      try {
        let probeTid: ReturnType<typeof setTimeout>;
        await Promise.race([
          this.browser.version().finally(() => clearTimeout(probeTid)),
          new Promise<never>((_, reject) => {
            probeTid = setTimeout(
              () => reject(new Error('connection probe timeout')),
              DEFAULT_HEARTBEAT_PING_TIMEOUT_MS,
            );
          }),
        ]);
        this.lastVerifiedAt = Date.now();
        return;
      } catch {
        console.error('[CDPClient] Connection probe failed, reconnecting...');
        await this.forceReconnect();
        return;
      }
    }

    // Coalesce concurrent connect() calls — only one connectInternal() runs at a time.
    // Without this, parallel tool calls (e.g., ultrapilot workflows) each trigger
    // connectInternal(), creating duplicate WebSocket connections where the second
    // overwrites this.browser and orphans the first's event listeners + heartbeat.
    if (this.pendingConnect) {
      console.error('[CDPClient] Coalescing concurrent connect() call');
      return this.pendingConnect;
    }

    this.connectionState = 'connecting';
    this.pendingConnect = (async () => {
      try {
        await this.connectInternal();
        this.lastVerifiedAt = Date.now();
        this.startHeartbeat();
        console.error('[CDPClient] Connected to Chrome');
      } catch (err) {
        this.connectionState = 'disconnected';
        throw err;
      }
    })();

    try {
      await this.pendingConnect;
    } finally {
      this.pendingConnect = null;
    }
  }

  /**
   * Force reconnect by disconnecting and reconnecting.
   * Invalidates any pending connect() promise — the old connection attempt
   * will still resolve but its result is discarded because this.browser is replaced.
   *
   * Clears ALL stale state (sessions, targetIdIndex, cookie scans) to prevent
   * post-reconnect operations from using orphaned page references that would
   * hang until protocolTimeout (30s).
   */
  async forceReconnect(): Promise<void> {
    // Invalidate any in-flight connect() — we're replacing the connection entirely
    this.pendingConnect = null;
    this.stopHeartbeat();

    if (this.browser) {
      try {
        this.browser.removeAllListeners('disconnected');
        this.browser.removeAllListeners('targetdestroyed');
        await this.browser.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.browser = null;
      this.sessions.clear();
      this.targetIdIndex.clear();
      this.inFlightCookieScans.clear();
    }

    this.connectionState = 'connecting';
    this.lastVerifiedAt = 0;
    await this.connectInternal();
    this.lastVerifiedAt = Date.now();
    this.consecutiveHeartbeatFailures = 0;
    this.startHeartbeat();
    console.error('[CDPClient] Reconnected to Chrome');
  }

  /**
   * Disconnect from Chrome
   */
  async disconnect(): Promise<void> {
    this.stopHeartbeat();

    if (this.browser) {
      try {
        this.browser.removeAllListeners('disconnected');
        this.browser.removeAllListeners('targetdestroyed');
        await this.browser.disconnect();
      } catch {
        // Browser might already be disconnected
      }
      this.browser = null;
      this.sessions.clear();
      this.connectionState = 'disconnected';
      console.error('[CDPClient] Disconnected from Chrome');
    }
  }

  /**
   * Get browser instance
   */
  getBrowser(): Browser {
    if (!this.browser) {
      throw new Error('Not connected to Chrome. Call connect() first.');
    }
    return this.browser;
  }

  // Default viewport for consistent debugging experience
  static readonly DEFAULT_VIEWPORT = DEFAULT_VIEWPORT;

  /**
   * Create a new isolated browser context for session isolation
   * Each context has its own cookies, localStorage, sessionStorage
   */
  async createBrowserContext(): Promise<BrowserContext> {
    const browser = this.getBrowser();
    const context = await browser.createBrowserContext();
    console.error(`[CDPClient] Created new browser context`);
    return context;
  }

  /**
   * Close a browser context and all its pages
   */
  async closeBrowserContext(context: BrowserContext): Promise<void> {
    try {
      await context.close();
      console.error(`[CDPClient] Closed browser context`);
    } catch (e) {
      // Context may already be closed
      console.error(`[CDPClient] Error closing browser context:`, e);
    }
  }

  /**
   * Check if a hostname is localhost
   */
  private isLocalhost(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch {
      return false;
    }
  }

  /**
   * Calculate domain match score between two URLs
   * Higher score = better match
   */
  private domainMatchScore(candidateUrl: string, targetDomain: string): number {
    try {
      const candidateHostname = new URL(candidateUrl).hostname;
      const candidateParts = candidateHostname.split('.').reverse();
      const targetParts = targetDomain.split('.').reverse();

      // Exact match
      if (candidateHostname === targetDomain) {
        return 100;
      }

      // Count matching TLD parts from right to left
      let matchingParts = 0;
      for (let i = 0; i < Math.min(candidateParts.length, targetParts.length); i++) {
        if (candidateParts[i] === targetParts[i]) {
          matchingParts++;
        } else {
          break;
        }
      }

      // Subdomain match (e.g., api.example.com matches example.com)
      if (matchingParts >= 2) {
        return 50 + matchingParts * 10;
      }

      // Same TLD only (e.g., both .com)
      if (matchingParts === 1) {
        return 10;
      }

      return 0;
    } catch {
      return 0;
    }
  }

  /**
   * Find an authenticated page with cookies to copy from.
   * Returns the targetId of a page that has cookies in Chrome's default context.
   *
   * Promise coalescing: concurrent callers for the same domain share one probe
   * instead of independently hammering Chrome with 20 simultaneous scans.
   *
   * @param targetDomain Optional domain to prioritize when selecting cookie source
   */
  async findAuthenticatedPageTargetId(targetDomain?: string): Promise<string | null> {
    // Check cache first (stale targetId is handled gracefully: copyCookiesViaCDP returns 0)
    const cacheKey = targetDomain || '*';
    const cached = this.cookieSourceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CDPClient.COOKIE_CACHE_TTL) {
      console.error(`[CDPClient] Cache hit for cookie source (domain: ${cacheKey}): ${cached.targetId.slice(0, 8)}`);
      return cached.targetId;
    }

    // Promise coalescing: if a scan for this domain is already in-flight, reuse it
    const existing = this.inFlightCookieScans.get(cacheKey);
    if (existing) {
      console.error(`[CDPClient] Coalescing cookie scan for domain: ${cacheKey}`);
      return existing;
    }

    // Start the scan and register it so concurrent callers share this promise
    const scanPromise = this._doFindAuthenticatedPageTargetId(targetDomain, cacheKey);
    this.inFlightCookieScans.set(cacheKey, scanPromise);
    try {
      return await scanPromise;
    } finally {
      this.inFlightCookieScans.delete(cacheKey);
    }
  }

  /**
   * Internal implementation of the authenticated-page probe.
   * Uses Target.attachToTarget (multiplexed CDP) instead of raw WebSocket connections.
   * Uses Target.getTargets result directly instead of /json/list HTTP calls.
   */
  private async _doFindAuthenticatedPageTargetId(targetDomain: string | undefined, cacheKey: string): Promise<string | null> {
    const scanStart = Date.now();
    const browser = this.getBrowser();
    const session = await browser.target().createCDPSession();

    try {
      const { targetInfos } = await session.send('Target.getTargets') as {
        targetInfos: Array<{ targetId: string; browserContextId?: string; type: string; url: string }>;
      };

      // Filter to candidate pages (not chrome://, not login pages, etc.)
      let candidates = targetInfos.filter(target =>
        target.type === 'page' &&
        !target.url.startsWith('chrome://') &&
        !target.url.startsWith('chrome-extension://') &&
        target.url !== 'about:blank' &&
        !target.url.includes('/login') &&
        !target.url.includes('/signin') &&
        !target.url.includes('/auth')
      );

      if (candidates.length === 0) {
        console.error('[CDPClient] No candidate pages found for cookie source');
        return null;
      }

      // If targeting an external domain (not localhost), exclude localhost pages
      if (targetDomain && !this.isLocalhost(`https://${targetDomain}`)) {
        const externalCandidates = candidates.filter(c => !this.isLocalhost(c.url));
        if (externalCandidates.length > 0) {
          console.error(`[CDPClient] Filtered out ${candidates.length - externalCandidates.length} localhost pages for external domain target`);
          candidates = externalCandidates;
        }
      }

      // Sort candidates by domain match score (highest first)
      if (targetDomain) {
        candidates.sort((a, b) => {
          const scoreA = this.domainMatchScore(a.url, targetDomain);
          const scoreB = this.domainMatchScore(b.url, targetDomain);
          return scoreB - scoreA;
        });
        console.error(`[CDPClient] Sorted ${candidates.length} candidates by domain match to ${targetDomain}`);
      }

      // Limit candidates to prevent N×30s cascading timeouts in parallel sessions.
      // Best-match candidates are already sorted first, so truncating is safe.
      if (candidates.length > DEFAULT_COOKIE_SCAN_MAX_CANDIDATES) {
        console.error(`[CDPClient] Limiting cookie scan from ${candidates.length} to ${DEFAULT_COOKIE_SCAN_MAX_CANDIDATES} candidates`);
        candidates = candidates.slice(0, DEFAULT_COOKIE_SCAN_MAX_CANDIDATES);
      }

      // Check each candidate to find one with actual cookies (in priority order).
      // Uses Target.attachToTarget over the existing multiplexed session — no raw WebSocket,
      // no /json/list HTTP round-trip.
      for (const candidate of candidates) {
        // Check overall scan timeout to prevent cascading hangs
        if (Date.now() - scanStart > DEFAULT_COOKIE_SCAN_TIMEOUT_MS) {
          console.error(`[CDPClient] Cookie scan timed out after ${Date.now() - scanStart}ms`);
          return null;
        }

        let attachedSessionId: string | null = null;
        try {
          // Per-candidate timeout to skip unresponsive tabs quickly
          let attachTid: ReturnType<typeof setTimeout>;
          const { sessionId } = await Promise.race([
            session.send('Target.attachToTarget', {
              targetId: candidate.targetId,
              flatten: true,
            }).finally(() => clearTimeout(attachTid)),
            new Promise<never>((_, reject) => {
              attachTid = setTimeout(() => reject(new Error('cookie scan: attach timeout')), DEFAULT_COOKIE_SCAN_PER_TARGET_TIMEOUT_MS);
            }),
          ]) as { sessionId: string };
          attachedSessionId = sessionId;

          // Send Network.getAllCookies through the flat CDP session (with per-target timeout)
          let cookiesTid: ReturnType<typeof setTimeout>;
          const result = await Promise.race([
            (session.send('Network.getAllCookies' as any, undefined, { sessionId } as any) as Promise<{ cookies: CookieEntry[] }>).finally(() => clearTimeout(cookiesTid)),
            new Promise<never>((_, reject) => {
              cookiesTid = setTimeout(() => reject(new Error('cookie scan: getAllCookies timeout')), DEFAULT_COOKIE_SCAN_PER_TARGET_TIMEOUT_MS);
            }),
          ]) as { cookies: CookieEntry[] };
          const cookieCount = result?.cookies?.length || 0;

          if (cookieCount > 0) {
            const domainScore = targetDomain ? this.domainMatchScore(candidate.url, targetDomain) : 0;
            console.error(`[CDPClient] Found authenticated page ${candidate.targetId.slice(0, 8)} at ${candidate.url.slice(0, 50)} (${cookieCount} cookies, domain score: ${domainScore})`);
            this.cookieSourceCache.set(cacheKey, { targetId: candidate.targetId, timestamp: Date.now() });
            return candidate.targetId;
          }
        } catch {
          // Target may be unresponsive, timed out, or already detached — skip
        } finally {
          if (attachedSessionId) {
            await session.send('Target.detachFromTarget', { sessionId: attachedSessionId }).catch(() => {});
          }
        }
      }

      console.error('[CDPClient] No pages with cookies found');
      return null;
    } finally {
      await session.detach().catch(() => {});
    }
  }

  /**
   * Copy all cookies from authenticated page to destination page.
   * Uses Target.attachToTarget (multiplexed CDP) to bypass Puppeteer's context isolation —
   * no raw WebSocket connections, no /json/list HTTP calls.
   */
  async copyCookiesViaCDP(sourceTargetId: string, destPage: Page): Promise<number> {
    console.error(`[CDPClient] copyCookiesViaCDP called with sourceTargetId: ${sourceTargetId.slice(0, 8)}`);

    try {
      // Check cookie data cache first — avoids re-probing Chrome entirely
      const cachedData = this.cookieDataCache.get(sourceTargetId);
      if (cachedData && Date.now() - cachedData.timestamp < CDPClient.COOKIE_CACHE_TTL) {
        console.error(`[CDPClient] Cache hit for cookie data (${cachedData.cookies.length} cookies), skipping CDP attach`);
        const destSession = await destPage.createCDPSession();
        try {
          const cookiesToSet = cachedData.cookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite as 'Strict' | 'Lax' | 'None' | undefined,
          }));
          await destSession.send('Network.setCookies', { cookies: cookiesToSet });
          console.error(`[CDPClient] Successfully copied ${cachedData.cookies.length} cookies (from cache)`);
          return cachedData.cookies.length;
        } finally {
          await destSession.detach().catch(() => {});
        }
      }

      // Attach to the source target via the multiplexed browser CDP session
      const browser = this.getBrowser();
      const browserSession = await browser.target().createCDPSession();
      let attachedSessionId: string | null = null;

      try {
        // Verify the target exists before attaching
        const { targetInfos } = await browserSession.send('Target.getTargets') as {
          targetInfos: Array<{ targetId: string; url: string }>;
        };
        const sourceInfo = targetInfos.find(t => t.targetId === sourceTargetId);
        if (!sourceInfo) {
          console.error(`[CDPClient] Source target not found: ${sourceTargetId.slice(0, 8)}`);
          console.error(`[CDPClient] Available targets: ${targetInfos.map(t => t.targetId.slice(0, 8) + ' ' + t.url.slice(0, 40)).join(', ')}`);
          return 0;
        }

        console.error(`[CDPClient] Attaching to source target at ${sourceInfo.url.slice(0, 50)}`);

        const { sessionId } = await browserSession.send('Target.attachToTarget', {
          targetId: sourceTargetId,
          flatten: true,
        }) as { sessionId: string };
        attachedSessionId = sessionId;

        // Fetch cookies through the flat session (no raw WebSocket, no /json/list)
        const result = await browserSession.send('Network.getAllCookies' as any, undefined, { sessionId } as any) as {
          cookies: CookieEntry[];
        };
        const cookies: CookieEntry[] = result?.cookies || [];

        // Store in cookie data cache
        this.cookieDataCache.set(sourceTargetId, { cookies, timestamp: Date.now() });

        if (cookies.length === 0) {
          console.error('[CDPClient] No cookies found in source page');
          return 0;
        }

        console.error(`[CDPClient] Found ${cookies.length} cookies, setting on destination page`);

        // Set cookies on destination page via its own CDPSession
        const destSession = await destPage.createCDPSession();
        try {
          const cookiesToSet = cookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite as 'Strict' | 'Lax' | 'None' | undefined,
          }));
          await destSession.send('Network.setCookies', { cookies: cookiesToSet });
          console.error(`[CDPClient] Successfully copied ${cookies.length} cookies`);
          return cookies.length;
        } finally {
          await destSession.detach().catch(() => {});
        }
      } finally {
        if (attachedSessionId) {
          await browserSession.send('Target.detachFromTarget', { sessionId: attachedSessionId }).catch(() => {});
        }
        await browserSession.detach().catch(() => {});
      }

    } catch (error) {
      console.error('[CDPClient] Error in copyCookiesViaCDP:', error);
      return 0;
    }
  }

  /**
   * Create a new page with default viewport
   * @param url Optional URL to navigate to
   * @param context Optional browser context for session isolation (null/undefined = use Chrome's default context with cookies)
   * @param skipCookieBridge If true, skip cookie bridging from authenticated pages (used for pool pre-warming)
   */
  async createPage(url?: string, context?: BrowserContext | null, skipCookieBridge?: boolean): Promise<Page> {
    let page: Page;
    const browser = this.getBrowser();

    // Extract domain from URL for cookie source prioritization
    let targetDomain: string | undefined;
    if (url) {
      try {
        targetDomain = new URL(url).hostname;
        console.error(`[CDPClient] createPage targeting domain: ${targetDomain}`);
      } catch {
        // Invalid URL, proceed without domain preference
      }
    }

    if (context) {
      // Create page in isolated context (for worker isolation)
      let newPageTid1: ReturnType<typeof setTimeout>;
      page = await Promise.race([
        context.newPage().finally(() => clearTimeout(newPageTid1)),
        new Promise<never>((_, reject) => {
          newPageTid1 = setTimeout(() => reject(new Error(`newPage() timed out after ${DEFAULT_NEW_PAGE_TIMEOUT_MS}ms`)), DEFAULT_NEW_PAGE_TIMEOUT_MS);
        }),
      ]) as Page;
    } else {
      // Create page in Chrome's default context
      let newPageTid2: ReturnType<typeof setTimeout>;
      page = await Promise.race([
        browser.newPage().finally(() => clearTimeout(newPageTid2)),
        new Promise<never>((_, reject) => {
          newPageTid2 = setTimeout(() => reject(new Error(`newPage() timed out after ${DEFAULT_NEW_PAGE_TIMEOUT_MS}ms`)), DEFAULT_NEW_PAGE_TIMEOUT_MS);
        }),
      ]) as Page;

      // Copy cookies from an authenticated page (skip for pool pre-warming to avoid
      // CDP session conflicts and unnecessary overhead on about:blank pages).
      // Overall timeout prevents cascading hangs from unresponsive source tabs.
      if (!skipCookieBridge) {
        const authPageTargetId = await this.findAuthenticatedPageTargetId(targetDomain);
        if (authPageTargetId) {
          await Promise.race([
            this.copyCookiesViaCDP(authPageTargetId, page),
            new Promise<void>((resolve) =>
              setTimeout(() => {
                console.error(`[CDPClient] Cookie copy timed out after ${DEFAULT_COOKIE_COPY_TIMEOUT_MS}ms, proceeding without cookies`);
                resolve();
              }, DEFAULT_COOKIE_COPY_TIMEOUT_MS),
            ),
          ]);
        }
      }
    }

    // Index page for O(1) target-to-page lookups (replaces eager targetcreated indexing)
    this.targetIdIndex.set(getTargetId(page.target()), page);

    // Set default viewport for consistent debugging experience (non-critical; swallow timeout)
    await Promise.race([
      page.setViewport(CDPClient.DEFAULT_VIEWPORT),
      new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_PAGE_CONFIG_TIMEOUT_MS)),
    ]);

    if (url) {
      try {
        await smartGoto(page, url, { timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
      } catch (err) {
        // Close the page to prevent about:blank ghost tabs on navigation failure
        const targetId = getTargetId(page.target());
        this.targetIdIndex.delete(targetId);
        await page.close().catch(() => {});
        throw err;
      }
    }

    return page;
  }

  /**
   * Get all page targets
   */
  async getPages(): Promise<Page[]> {
    const browser = this.getBrowser();
    return browser.pages();
  }

  /**
   * Get page by target ID
   */
  async getPageByTargetId(targetId: string): Promise<Page | null> {
    // Fast path: check index first (O(1))
    const indexed = this.targetIdIndex.get(targetId);
    if (indexed && !indexed.isClosed()) {
      return indexed;
    }

    // Fallback: linear scan (for pages created before indexing started)
    const browser = this.getBrowser();
    const targets = browser.targets();

    for (const target of targets) {
      if (getTargetId(target) === targetId && target.type() === 'page') {
        const page = await Promise.race([
          target.page(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
        ]);
        if (page) {
          // Populate index for future lookups
          this.targetIdIndex.set(targetId, page);
        }
        return page;
      }
    }

    // Clean stale index entry
    this.targetIdIndex.delete(targetId);
    return null;
  }

  /**
   * Get CDP session for a page
   */
  async getCDPSession(page: Page): Promise<CDPSession> {
    const target = page.target();
    const targetId = getTargetId(target);

    let session = this.sessions.get(targetId);
    if (!session) {
      session = await page.createCDPSession();
      this.sessions.set(targetId, session);
    }

    return session;
  }

  /**
   * Execute CDP command on a page
   */
  async send<T = unknown>(
    page: Page,
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    const session = await this.getCDPSession(page);
    return session.send(method as any, params as any) as Promise<T>;
  }

  /**
   * Get all targets
   */
  getTargets(): Target[] {
    return this.getBrowser().targets();
  }

  /**
   * Find target by ID
   */
  findTarget(targetId: string): Target | undefined {
    return this.getTargets().find((t) => getTargetId(t) === targetId);
  }

  /**
   * Trigger garbage collection on a page (best-effort)
   */
  async triggerGC(page: Page): Promise<void> {
    try {
      const session = await this.getCDPSession(page);
      await session.send('HeapProfiler.collectGarbage' as any);
    } catch {
      // Best-effort: silently ignore GC failures
    }
  }

  /**
   * Close a page by target ID
   */
  async closePage(targetId: string): Promise<void> {
    const page = await this.getPageByTargetId(targetId);
    if (page) {
      await this.triggerGC(page);
      await page.close();
      this.sessions.delete(targetId);
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  /**
   * Get the port this client is connected to
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Create a CDPClient instance for a specific port
   */
  static createForPort(port: number, options?: CDPClientOptions): CDPClient {
    return new CDPClient({ ...options, port });
  }
}

// Singleton instance
let clientInstance: CDPClient | null = null;

export function getCDPClient(options?: CDPClientOptions): CDPClient {
  if (!clientInstance) {
    clientInstance = new CDPClient(options);
  }
  return clientInstance;
}

/**
 * Factory for managing multiple CDPClient instances (one per Chrome port)
 */
export class CDPClientFactory {
  private clients: Map<number, CDPClient> = new Map();

  /**
   * Get an existing client for the given port, or create a new one
   */
  getOrCreate(port: number, options?: CDPClientOptions): CDPClient {
    let client = this.clients.get(port);
    if (!client) {
      client = CDPClient.createForPort(port, options);
      this.clients.set(port, client);
    }
    return client;
  }

  /**
   * Get an existing client for the given port, or undefined if not found
   */
  get(port: number): CDPClient | undefined {
    return this.clients.get(port);
  }

  /**
   * Get all managed client instances
   */
  getAll(): CDPClient[] {
    return Array.from(this.clients.values());
  }

  /**
   * Disconnect all managed clients
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.clients.values()).map(client =>
      client.disconnect().catch(err =>
        console.error(`[CDPClientFactory] Error disconnecting client on port ${client.getPort()}:`, err)
      )
    );
    await Promise.all(disconnectPromises);
    this.clients.clear();
  }
}

// Singleton factory instance
let factoryInstance: CDPClientFactory | null = null;

export function getCDPClientFactory(): CDPClientFactory {
  if (!factoryInstance) {
    factoryInstance = new CDPClientFactory();
  }
  return factoryInstance;
}
