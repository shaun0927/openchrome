/**
 * 3-Level Circuit Breaker — prevents repeated failures from wasting time.
 *
 * Three independent scopes:
 * - Element: same query on same tab fails N times → skip waterfall
 * - Page: too many failed elements on same tab → suggest reload
 * - Global: too many failures across all tabs → pause interactions
 *
 * Each breaker follows the standard state machine:
 *   CLOSED (normal) → OPEN (fail-fast) → HALF_OPEN (probe) → CLOSED
 *
 * All breakers auto-reset after a cooldown — never permanently block.
 */

// ─── Types ───

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerStatus {
  state: BreakerState;
  failures: number;
  lastFailureTime: number;
  suggestion?: string;
}

export interface CircuitBreakerConfig {
  /** Failures before element breaker opens (default: 3) */
  elementThreshold?: number;
  /** Element breaker auto-reset in ms (default: 120000 = 2 min) */
  elementResetMs?: number;
  /** Distinct failed elements before page breaker opens (default: 5) */
  pageThreshold?: number;
  /** Page breaker auto-reset in ms (default: 60000 = 1 min) */
  pageResetMs?: number;
  /** Total failures in sliding window before global breaker opens (default: 10) */
  globalThreshold?: number;
  /** Global sliding window in ms (default: 300000 = 5 min) */
  globalWindowMs?: number;
  /** Global breaker cooldown in ms (default: 300000 = 5 min) */
  globalResetMs?: number;
}

// ─── Element Breaker Entry ───

interface ElementEntry {
  failures: number;
  state: BreakerState;
  openedAt: number;       // timestamp when breaker opened
  lastFailureTime: number;
}

// ─── Page Breaker Entry ───

interface PageEntry {
  failedElements: Set<string>;  // distinct query hashes that failed
  state: BreakerState;
  openedAt: number;
  lastFailureTime: number;
}

// ─── Implementation ───

export class CircuitBreaker {
  private elements = new Map<string, ElementEntry>();
  private pages = new Map<string, PageEntry>();
  private globalFailures: number[] = [];  // timestamps of recent failures
  private globalState: BreakerState = 'CLOSED';
  private globalOpenedAt = 0;

  private readonly elementThreshold: number;
  private readonly elementResetMs: number;
  private readonly pageThreshold: number;
  private readonly pageResetMs: number;
  private readonly globalThreshold: number;
  private readonly globalWindowMs: number;
  private readonly globalResetMs: number;

  constructor(config?: CircuitBreakerConfig) {
    this.elementThreshold = config?.elementThreshold ?? 3;
    this.elementResetMs = config?.elementResetMs ?? 120_000;
    this.pageThreshold = config?.pageThreshold ?? 5;
    this.pageResetMs = config?.pageResetMs ?? 60_000;
    this.globalThreshold = config?.globalThreshold ?? 10;
    this.globalWindowMs = config?.globalWindowMs ?? 300_000;
    this.globalResetMs = config?.globalResetMs ?? 300_000;
  }

  // ─── Element Level ───

  /**
   * Check element breaker state for a specific query on a tab.
   */
  checkElement(tabId: string, queryHash: string): BreakerStatus {
    const key = `${tabId}:${queryHash}`;
    const entry = this.elements.get(key);

    if (!entry || entry.state === 'CLOSED') {
      return { state: 'CLOSED', failures: entry?.failures ?? 0, lastFailureTime: entry?.lastFailureTime ?? 0 };
    }

    const now = Date.now();

    // Auto-reset after cooldown
    if (entry.state === 'OPEN' && now - entry.openedAt >= this.elementResetMs) {
      entry.state = 'HALF_OPEN';
      return { state: 'HALF_OPEN', failures: entry.failures, lastFailureTime: entry.lastFailureTime };
    }

    return {
      state: entry.state,
      failures: entry.failures,
      lastFailureTime: entry.lastFailureTime,
      suggestion: `Element "${queryHash}" has failed ${entry.failures} times. Try a different approach.`,
    };
  }

  /**
   * Record a failure for an element interaction.
   */
  recordElementFailure(tabId: string, queryHash: string): void {
    const key = `${tabId}:${queryHash}`;
    const now = Date.now();

    let entry = this.elements.get(key);
    if (!entry) {
      entry = { failures: 0, state: 'CLOSED', openedAt: 0, lastFailureTime: 0 };
      this.elements.set(key, entry);
    }

    entry.failures++;
    entry.lastFailureTime = now;

    if (entry.failures >= this.elementThreshold && entry.state === 'CLOSED') {
      entry.state = 'OPEN';
      entry.openedAt = now;
    }

    // Also record at page and global level
    this.recordPageFailure(tabId, queryHash);
    this.recordGlobalFailure();
  }

  /**
   * Record a success — resets the element breaker to CLOSED.
   */
  recordElementSuccess(tabId: string, queryHash: string): void {
    const key = `${tabId}:${queryHash}`;
    this.elements.delete(key);
  }

  // ─── Page Level ───

  private recordPageFailure(tabId: string, queryHash: string): void {
    let entry = this.pages.get(tabId);
    if (!entry) {
      entry = { failedElements: new Set(), state: 'CLOSED', openedAt: 0, lastFailureTime: 0 };
      this.pages.set(tabId, entry);
    }

    entry.failedElements.add(queryHash);
    entry.lastFailureTime = Date.now();

    if (entry.failedElements.size >= this.pageThreshold && entry.state === 'CLOSED') {
      entry.state = 'OPEN';
      entry.openedAt = Date.now();
    }
  }

  /**
   * Check page-level health.
   */
  checkPage(tabId: string): BreakerStatus {
    const entry = this.pages.get(tabId);

    if (!entry || entry.state === 'CLOSED') {
      return { state: 'CLOSED', failures: entry?.failedElements.size ?? 0, lastFailureTime: entry?.lastFailureTime ?? 0 };
    }

    const now = Date.now();

    if (entry.state === 'OPEN' && now - entry.openedAt >= this.pageResetMs) {
      entry.state = 'HALF_OPEN';
      entry.failedElements.clear();
      return { state: 'HALF_OPEN', failures: 0, lastFailureTime: entry.lastFailureTime };
    }

    return {
      state: entry.state,
      failures: entry.failedElements.size,
      lastFailureTime: entry.lastFailureTime,
      suggestion: `${entry.failedElements.size} elements failed on this page. Consider page reload or alternate navigation.`,
    };
  }

  /**
   * Reset page breaker (e.g., after navigation to new URL).
   */
  resetPage(tabId: string): void {
    this.pages.delete(tabId);
    // Also clean element entries for this tab
    for (const key of this.elements.keys()) {
      if (key.startsWith(`${tabId}:`)) {
        this.elements.delete(key);
      }
    }
  }

  // ─── Global Level ───

  private recordGlobalFailure(): void {
    const now = Date.now();
    this.globalFailures.push(now);

    // Prune old entries outside the sliding window
    this.globalFailures = this.globalFailures.filter(t => now - t < this.globalWindowMs);

    if (this.globalFailures.length >= this.globalThreshold && this.globalState === 'CLOSED') {
      this.globalState = 'OPEN';
      this.globalOpenedAt = now;
    }
  }

  /**
   * Check global health.
   */
  checkGlobal(): BreakerStatus {
    if (this.globalState === 'CLOSED') {
      const now = Date.now();
      const recent = this.globalFailures.filter(t => now - t < this.globalWindowMs).length;
      return { state: 'CLOSED', failures: recent, lastFailureTime: this.globalFailures[this.globalFailures.length - 1] ?? 0 };
    }

    const now = Date.now();

    if (this.globalState === 'OPEN' && now - this.globalOpenedAt >= this.globalResetMs) {
      this.globalState = 'HALF_OPEN';
      return { state: 'HALF_OPEN', failures: this.globalFailures.length, lastFailureTime: this.globalOpenedAt };
    }

    return {
      state: this.globalState,
      failures: this.globalFailures.length,
      lastFailureTime: this.globalOpenedAt,
      suggestion: 'Too many interaction failures. Interactions paused — please review the current page state.',
    };
  }

  /**
   * Record a global success — transitions HALF_OPEN back to CLOSED.
   */
  recordGlobalSuccess(): void {
    if (this.globalState === 'HALF_OPEN') {
      this.globalState = 'CLOSED';
      this.globalFailures = [];
    }
  }

  // ─── Combined Check ───

  /**
   * Check all three levels at once. Returns the most restrictive state.
   */
  check(tabId: string, queryHash: string): {
    allowed: boolean;
    level: 'element' | 'page' | 'global' | null;
    status: BreakerStatus;
  } {
    // Global first (most restrictive)
    const global = this.checkGlobal();
    if (global.state === 'OPEN') {
      return { allowed: false, level: 'global', status: global };
    }

    // Page level
    const page = this.checkPage(tabId);
    if (page.state === 'OPEN') {
      return { allowed: false, level: 'page', status: page };
    }

    // Element level
    const element = this.checkElement(tabId, queryHash);
    if (element.state === 'OPEN') {
      return { allowed: false, level: 'element', status: element };
    }

    // HALF_OPEN allows a single probe
    return { allowed: true, level: null, status: { state: 'CLOSED', failures: 0, lastFailureTime: 0 } };
  }

  /**
   * Reset all breakers (e.g., on session cleanup).
   */
  reset(): void {
    this.elements.clear();
    this.pages.clear();
    this.globalFailures = [];
    this.globalState = 'CLOSED';
    this.globalOpenedAt = 0;
  }
}

// ─── Singleton ───

let instance: CircuitBreaker | null = null;

export function getCircuitBreaker(config?: CircuitBreakerConfig): CircuitBreaker {
  if (!instance) {
    instance = new CircuitBreaker(config);
  }
  return instance;
}

/**
 * Simple string hash for query deduplication.
 */
export function hashQuery(query: string): string {
  let hash = 0;
  for (let i = 0; i < query.length; i++) {
    hash = ((hash << 5) - hash + query.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}
