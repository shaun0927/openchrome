/**
 * Per-Tab Health Monitor — detects frozen/crashed renderer tabs.
 * Runs independently of the global CDPClient heartbeat.
 * Part of #347 Layer 1: CDP Connection Resilience.
 */

import { EventEmitter } from 'events';
import { Page } from 'puppeteer-core';

export type TabHealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface TabHealthInfo {
  targetId: string;
  status: TabHealthStatus;
  consecutiveFailures: number;
  lastCheckedAt: number;
  lastHealthyAt: number;
}

export interface TabHealthMonitorOptions {
  /** How often to probe idle tabs (ms). Default: 60000 (60s) */
  probeIntervalMs?: number;
  /** Timeout for each probe (ms). Default: 5000 (5s) */
  probeTimeoutMs?: number;
  /** Consecutive failures before marking unhealthy. Default: 3 */
  unhealthyThreshold?: number;
  /** Consecutive failures before auto-eviction. Default: 5 */
  evictionThreshold?: number;
}

export class TabHealthMonitor extends EventEmitter {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private health: Map<string, TabHealthInfo> = new Map();
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly unhealthyThreshold: number;
  private readonly evictionThreshold: number;

  constructor(opts?: TabHealthMonitorOptions) {
    super();
    this.probeIntervalMs = opts?.probeIntervalMs ?? 60000;
    this.probeTimeoutMs = opts?.probeTimeoutMs ?? 5000;
    this.unhealthyThreshold = opts?.unhealthyThreshold ?? 3;
    this.evictionThreshold = opts?.evictionThreshold ?? 5;
  }

  /**
   * Start monitoring a tab's renderer health.
   */
  monitorTab(targetId: string, page: Page): void {
    // Remove existing monitor if any
    this.unmonitorTab(targetId);

    const now = Date.now();
    this.health.set(targetId, {
      targetId,
      status: 'healthy',
      consecutiveFailures: 0,
      lastCheckedAt: now,
      lastHealthyAt: now,
    });

    const timer = setInterval(async () => {
      await this.probeTab(targetId, page);
    }, this.probeIntervalMs);
    timer.unref();
    this.timers.set(targetId, timer);
  }

  /**
   * Stop monitoring a tab.
   */
  unmonitorTab(targetId: string): void {
    const timer = this.timers.get(targetId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(targetId);
    }
    this.health.delete(targetId);
  }

  /**
   * Probe a tab's renderer by executing minimal JavaScript.
   */
  private async probeTab(targetId: string, page: Page): Promise<void> {
    const info = this.health.get(targetId);
    if (!info) return;

    const now = Date.now();
    info.lastCheckedAt = now;

    try {
      // Race: lightweight JS execution vs timeout
      let probeTid: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        page.evaluate('1').finally(() => { if (probeTid) clearTimeout(probeTid); }),
        new Promise<never>((_, reject) => {
          probeTid = setTimeout(
            () => reject(new Error('tab health probe timeout')),
            this.probeTimeoutMs,
          );
        }),
      ]);

      // Success — tab is healthy
      if (info.status !== 'healthy') {
        console.error(`[TabHealthMonitor] Tab ${targetId} recovered (was ${info.status})`);
      }
      info.status = 'healthy';
      info.consecutiveFailures = 0;
      info.lastHealthyAt = now;
      this.emit('tab-healthy', { targetId });
    } catch (error) {
      info.consecutiveFailures++;

      if (info.consecutiveFailures >= this.evictionThreshold) {
        info.status = 'unhealthy';
        console.error(`[TabHealthMonitor] Tab ${targetId} eviction threshold reached (${info.consecutiveFailures} failures)`);
        // Consumers MUST listen for 'tab-evict' and close the evicted page
        // to prevent zombie renderer processes in Chrome.
        this.emit('tab-evict', { targetId, consecutiveFailures: info.consecutiveFailures });
        this.unmonitorTab(targetId); // stop monitoring evicted tab
      } else if (info.consecutiveFailures >= this.unhealthyThreshold) {
        info.status = 'unhealthy';
        console.error(`[TabHealthMonitor] Tab ${targetId} marked unhealthy (${info.consecutiveFailures} failures)`);
        this.emit('tab-unhealthy', { targetId, failures: info.consecutiveFailures });
      } else {
        console.error(`[TabHealthMonitor] Tab ${targetId} probe failed (strike ${info.consecutiveFailures}/${this.unhealthyThreshold}):`,
          error instanceof Error ? error.message : String(error));
      }
    }
  }

  /**
   * Get health status of a specific tab.
   */
  getTabHealth(targetId: string): TabHealthInfo | undefined {
    return this.health.get(targetId);
  }

  /**
   * Get health status of all monitored tabs.
   */
  getAllHealth(): Map<string, TabHealthInfo> {
    return new Map(this.health);
  }

  /**
   * Get count of monitored tabs.
   */
  getMonitoredTabCount(): number {
    return this.timers.size;
  }

  /**
   * Stop monitoring all tabs.
   */
  stopAll(): void {
    for (const targetId of [...this.timers.keys()]) {
      this.unmonitorTab(targetId);
    }
  }
}
