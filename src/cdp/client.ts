/**
 * CDP Client - Wrapper around puppeteer-core for Chrome DevTools Protocol
 */

import puppeteer, { Browser, Page, Target, CDPSession } from 'puppeteer-core';
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
  private reconnectAttempts = 0;
  private autoLaunch: boolean;

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

  /**
   * Create a new page
   */
  async createPage(url?: string): Promise<Page> {
    const browser = this.getBrowser();
    const page = await browser.newPage();

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
   * Close a page by target ID
   */
  async closePage(targetId: string): Promise<void> {
    const page = await this.getPageByTargetId(targetId);
    if (page) {
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
}

// Singleton instance
let clientInstance: CDPClient | null = null;

export function getCDPClient(options?: CDPClientOptions): CDPClient {
  if (!clientInstance) {
    clientInstance = new CDPClient(options);
  }
  return clientInstance;
}
