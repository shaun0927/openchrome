/**
 * Per-Tab Health Monitor — detects frozen/crashed renderer tabs.
 * Runs independently of the global CDPClient heartbeat.
 * Part of #347 Layer 1: CDP Connection Resilience.
 *
 * Idle-adaptive (issue #649 Part A): when the server is idle, each tab's
 * probe cadence relaxes from 60 s to 300 s (5× reduction). Each tab runs on
 * its own `setTimeout` chain so local scheduling stays independent.
 *
 * Console buffer pressure (issue #897): emits `console_buffer_pressure` when
 * retainedBytes > 0.9 * maxBytes for >= 30 seconds (sustained high-watermark).
 */

import { EventEmitter } from 'events';
import { Page } from 'puppeteer-core';
import { getIdleState, IDLE_WINDOW_MS, IdleState } from '../utils/idle-state';
import { captureStates } from '../tools/console-capture';

/** Fraction of maxBytes that triggers the pressure event. */
const PRESSURE_RATIO = 0.9;
/** Sustained duration before emitting the pressure event (ms). */
const PRESSURE_SUSTAIN_MS = 30_000;

/** Idle cadence. 300 s is 5× slower than the default 60 s active rate. */
const IDLE_PROBE_INTERVAL_MS = 300_000;

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
  /** Idle-state source. Defaults to the process-global singleton. */
  idleState?: IdleState;
}

interface TabMonitorState {
  page: Page;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  lastDelayMs: number;
}

export class TabHealthMonitor extends EventEmitter {
  private tabs: Map<string, TabMonitorState> = new Map();
  private health: Map<string, TabHealthInfo> = new Map();
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly unhealthyThreshold: number;
  private readonly evictionThreshold: number;
  private readonly idleState: IdleState;

  /**
   * Per-tab timestamp (ms) when retainedBytes first exceeded the pressure
   * threshold. Null means not currently in a high-water-mark state.
   * Reset once pressure drops below the threshold.
   */
  private readonly pressureOnsetAt: Map<string, number> = new Map();
  /** Tracks whether we have already fired the one-shot event per onset. */
  private readonly pressureFired: Map<string, boolean> = new Map();

  constructor(opts?: TabHealthMonitorOptions) {
    super();
    this.probeIntervalMs = opts?.probeIntervalMs ?? 60000;
    this.probeTimeoutMs = opts?.probeTimeoutMs ?? 5000;
    this.unhealthyThreshold = opts?.unhealthyThreshold ?? 3;
    this.evictionThreshold = opts?.evictionThreshold ?? 5;
    this.idleState = opts?.idleState ?? getIdleState();
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

    const state: TabMonitorState = { page, timer: null, stopped: false, lastDelayMs: 0 };
    this.tabs.set(targetId, state);
    this.scheduleNext(targetId, this.nextDelayMs());
  }

  /**
   * Stop monitoring a tab.
   */
  unmonitorTab(targetId: string): void {
    const state = this.tabs.get(targetId);
    if (state) {
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
      this.tabs.delete(targetId);
    }
    this.health.delete(targetId);
    this.pressureOnsetAt.delete(targetId);
    this.pressureFired.delete(targetId);
  }

  /**
   * Current scheduling delay for a specific tab — exposed for tests
   * asserting the active/idle rate transition (issue #649 §3.1).
   */
  getCurrentDelayMs(targetId: string): number | undefined {
    return this.tabs.get(targetId)?.lastDelayMs;
  }

  private nextDelayMs(): number {
    return this.idleState.isIdle(IDLE_WINDOW_MS) ? IDLE_PROBE_INTERVAL_MS : this.probeIntervalMs;
  }

  private scheduleNext(targetId: string, delay: number): void {
    const state = this.tabs.get(targetId);
    if (!state || state.stopped) return;
    state.lastDelayMs = delay;
    state.timer = setTimeout(async () => {
      if (state.stopped) return;
      await this.probeTab(targetId, state.page);
      // A failed probe may have evicted the tab — re-check before rescheduling.
      if (this.tabs.has(targetId)) {
        this.scheduleNext(targetId, this.nextDelayMs());
      }
    }, delay);
    state.timer.unref();
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
      this.checkBufferPressure(targetId, now);
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
   * Check console buffer byte pressure for the given tab.
   * Emits `console_buffer_pressure` (one-shot, debounced) when
   * retainedBytes > 0.9 * maxBytes for >= PRESSURE_SUSTAIN_MS.
   * Resets the onset clock once pressure drops below the threshold.
   */
  private checkBufferPressure(targetId: string, now: number): void {
    const captureState = captureStates.get(targetId);
    if (!captureState) return;

    const bufStats = captureState.logs.stats();
    const threshold = PRESSURE_RATIO * captureState.maxBytes;
    const underPressure = bufStats.retainedBytes > threshold;

    if (underPressure) {
      if (!this.pressureOnsetAt.has(targetId)) {
        // First probe above threshold — record onset time.
        this.pressureOnsetAt.set(targetId, now);
        this.pressureFired.set(targetId, false);
      }

      const onset = this.pressureOnsetAt.get(targetId)!;
      const alreadyFired = this.pressureFired.get(targetId) ?? false;

      if (!alreadyFired && now - onset >= PRESSURE_SUSTAIN_MS) {
        this.pressureFired.set(targetId, true);
        console.error(`[TabHealthMonitor] Tab ${targetId} console buffer pressure: ${bufStats.retainedBytes} / ${captureState.maxBytes} bytes`);
        this.emit('console_buffer_pressure', {
          targetId,
          retainedBytes: bufStats.retainedBytes,
          maxBytes: captureState.maxBytes,
          sustainedMs: now - onset,
        });
      }
    } else {
      // Pressure dropped — reset so a future high-water-mark fires again.
      this.pressureOnsetAt.delete(targetId);
      this.pressureFired.delete(targetId);
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
    return this.tabs.size;
  }

  /**
   * Stop monitoring all tabs.
   */
  stopAll(): void {
    for (const targetId of [...this.tabs.keys()]) {
      this.unmonitorTab(targetId);
    }
  }
}
