/**
 * CDP Client - Wrapper around puppeteer-core for Chrome DevTools Protocol
 */

import puppeteer, { Browser, BrowserContext, Page, Target, CDPSession } from 'puppeteer-core';
import { getChromeLauncher } from '../chrome/launcher';
import { getGlobalConfig } from '../config/global';

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
  type: 'connected' | 'disconnected' | 'reconnecting' | 'reconnect_failed';
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
  private targetDestroyedListeners: ((targetId: string) => void)[] = [];
  private reconnectAttempts = 0;
  private autoLaunch: boolean;
  private cookieSourceCache: Map<string, { targetId: string; timestamp: number }> = new Map();
  private cookieDataCache: Map<string, { cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite?: string }>; timestamp: number }> = new Map();
  private static readonly COOKIE_CACHE_TTL = 30000; // 30 seconds

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
  addTargetDestroyedListener(listener: (targetId: string) => void): void {
    this.targetDestroyedListeners.push(listener);
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
    for (const listener of this.targetDestroyedListeners) {
      try {
        listener(targetId);
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
   * Check connection health
   */
  private async checkConnection(): Promise<boolean> {
    if (!this.browser) {
      return false;
    }

    try {
      // Simple check - try to get browser version
      if (!this.browser.isConnected()) {
        console.error('[CDPClient] Heartbeat: Connection lost, attempting reconnect...');
        await this.handleDisconnect();
        return false;
      }
      return true;
    } catch (error) {
      console.error('[CDPClient] Heartbeat check failed:', error);
      await this.handleDisconnect();
      return false;
    }
  }

  /**
   * Handle disconnection with automatic reconnection
   */
  private async handleDisconnect(): Promise<void> {
    if (this.connectionState === 'reconnecting') {
      return; // Already reconnecting
    }

    this.connectionState = 'reconnecting';
    this.emitConnectionEvent({
      type: 'disconnected',
      timestamp: Date.now(),
    });

    // Clear existing sessions
    this.sessions.clear();
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

    this.browser = await puppeteer.connect({
      browserWSEndpoint: instance.wsEndpoint,
      defaultViewport: null,
    });

    // Set up disconnect handler
    this.browser.on('disconnected', () => {
      console.error('[CDPClient] Browser disconnected');
      this.handleDisconnect();
    });

    // Set up target destroyed handler
    this.browser.on('targetdestroyed', (target) => {
      const targetId = getTargetId(target);
      console.error(`[CDPClient] Target destroyed: ${targetId}`);
      this.onTargetDestroyed(targetId);
    });

    this.connectionState = 'connected';
    this.emitConnectionEvent({
      type: 'connected',
      timestamp: Date.now(),
    });
  }

  /**
   * Connect to Chrome instance
   */
  async connect(): Promise<void> {
    if (this.browser && this.browser.isConnected()) {
      // Verify connection is actually working by checking Chrome endpoint
      try {
        const launcher = getChromeLauncher(this.port);
        const instance = await launcher.ensureChrome({ autoLaunch: this.autoLaunch });
        const currentWsUrl = instance.wsEndpoint;

        // Check if the browser's WebSocket URL matches current Chrome
        const browserWsUrl = this.browser.wsEndpoint();
        if (browserWsUrl !== currentWsUrl) {
          console.error('[CDPClient] WebSocket URL mismatch, reconnecting...');
          await this.forceReconnect();
          return;
        }
        return;
      } catch {
        console.error('[CDPClient] Connection check failed, reconnecting...');
        await this.forceReconnect();
        return;
      }
    }

    this.connectionState = 'connecting';
    await this.connectInternal();
    this.startHeartbeat();
    console.error('[CDPClient] Connected to Chrome');
  }

  /**
   * Force reconnect by disconnecting and reconnecting
   */
  async forceReconnect(): Promise<void> {
    this.stopHeartbeat();

    if (this.browser) {
      try {
        this.browser.removeAllListeners('disconnected');
        await this.browser.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.browser = null;
      this.sessions.clear();
    }

    this.connectionState = 'connecting';
    await this.connectInternal();
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
  static readonly DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

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
   * Find an authenticated page with cookies to copy from
   * Returns the targetId of a page that has cookies in Chrome's default context
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

    const WebSocket = require('ws');
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

      // Get target list with WebSocket URLs
      const listResponse = await fetch(`http://127.0.0.1:${this.port}/json/list`);
      const targets = await listResponse.json() as Array<{ id: string; webSocketDebuggerUrl: string; url: string }>;

      // Check each candidate to find one with actual cookies (in priority order)
      for (const candidate of candidates) {
        const targetInfo = targets.find(t => t.id === candidate.targetId);
        if (!targetInfo || !targetInfo.webSocketDebuggerUrl) {
          continue;
        }

        // Check if this page has cookies (pages in Chrome's default context have cookies,
        // while Puppeteer-created pages have empty cookies)
        const cookieCount = await new Promise<number>((resolve) => {
          const ws = new WebSocket(targetInfo.webSocketDebuggerUrl);
          const timeout = setTimeout(() => { ws.close(); resolve(0); }, 2000);

          ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
          });

          ws.on('message', (data: Buffer) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 1) {
              clearTimeout(timeout);
              ws.close();
              resolve(msg.result?.cookies?.length || 0);
            }
          });

          ws.on('error', () => {
            clearTimeout(timeout);
            resolve(0);
          });
        });

        if (cookieCount > 0) {
          const domainScore = targetDomain ? this.domainMatchScore(candidate.url, targetDomain) : 0;
          console.error(`[CDPClient] Found authenticated page ${candidate.targetId.slice(0, 8)} at ${candidate.url.slice(0, 50)} (${cookieCount} cookies, domain score: ${domainScore})`);
          // Store in cache
          this.cookieSourceCache.set(cacheKey, { targetId: candidate.targetId, timestamp: Date.now() });
          return candidate.targetId;
        }
      }

      console.error('[CDPClient] No pages with cookies found');
      return null;
    } finally {
      await session.detach().catch(() => {});
    }
  }

  /**
   * Copy all cookies from authenticated page to destination page
   * Uses raw WebSocket CDP connection to bypass Puppeteer's context isolation
   */
  async copyCookiesViaCDP(sourceTargetId: string, destPage: Page): Promise<number> {
    const WebSocket = require('ws');

    console.error(`[CDPClient] copyCookiesViaCDP called with sourceTargetId: ${sourceTargetId.slice(0, 8)}`);

    try {
      // Check cookie data cache first
      const cachedData = this.cookieDataCache.get(sourceTargetId);
      if (cachedData && Date.now() - cachedData.timestamp < CDPClient.COOKIE_CACHE_TTL) {
        console.error(`[CDPClient] Cache hit for cookie data (${cachedData.cookies.length} cookies), skipping WebSocket`);
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

      // Get target's WebSocket URL
      const listResponse = await fetch(`http://127.0.0.1:${this.port}/json/list`);
      const targets = await listResponse.json() as Array<{ id: string; webSocketDebuggerUrl: string; url: string }>;

      const sourceTarget = targets.find(t => t.id === sourceTargetId);
      if (!sourceTarget || !sourceTarget.webSocketDebuggerUrl) {
        console.error(`[CDPClient] Source target not found in /json/list. Looking for: ${sourceTargetId}`);
        console.error(`[CDPClient] Available targets: ${targets.map(t => t.id.slice(0,8) + ' ' + t.url.slice(0,40)).join(', ')}`);
        return 0;
      }

      console.error(`[CDPClient] Connecting to source target at ${sourceTarget.url.slice(0, 50)}`);

      // Get cookies via WebSocket
      const cookies = await new Promise<Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite?: string }>>((resolve, reject) => {
        const ws = new WebSocket(sourceTarget.webSocketDebuggerUrl);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('WebSocket timeout'));
        }, 5000);

        ws.on('open', () => {
          ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
        });

        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.id === 1) {
            clearTimeout(timeout);
            ws.close();
            resolve(msg.result?.cookies || []);
          }
        });

        ws.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Store in cookie data cache
      this.cookieDataCache.set(sourceTargetId, { cookies, timestamp: Date.now() });

      if (cookies.length === 0) {
        console.error(`[CDPClient] No cookies found in source page`);
        return 0;
      }

      console.error(`[CDPClient] Found ${cookies.length} cookies, setting on destination page`);

      // Set cookies on destination page
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

    } catch (error) {
      console.error(`[CDPClient] Error in copyCookiesViaCDP:`, error);
      return 0;
    }
  }

  /**
   * Create a new page with default viewport
   * @param url Optional URL to navigate to
   * @param context Optional browser context for session isolation (null/undefined = use Chrome's default context with cookies)
   */
  async createPage(url?: string, context?: BrowserContext | null): Promise<Page> {
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
      page = await context.newPage();
    } else {
      // Create page and copy cookies from an authenticated page
      // This allows the new page to share the authenticated session
      page = await browser.newPage();

      // Find an authenticated page to copy cookies from (with domain preference)
      const authPageTargetId = await this.findAuthenticatedPageTargetId(targetDomain);
      if (authPageTargetId) {
        await this.copyCookiesViaCDP(authPageTargetId, page);
      }
    }

    // Set default viewport for consistent debugging experience
    await page.setViewport(CDPClient.DEFAULT_VIEWPORT);

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
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
    const browser = this.getBrowser();
    const targets = browser.targets();

    for (const target of targets) {
      if (getTargetId(target) === targetId && target.type() === 'page') {
        const page = await target.page();
        return page;
      }
    }

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
