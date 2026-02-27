/**
 * Adaptive Screenshot - Tracks screenshot history per tab and degrades
 * response format on repetition to reduce token waste from screenshot loops.
 *
 * Returns a mode ('full' | 'annotated' | 'text_only') based on how many times
 * the same scroll position has been captured within a recent time window.
 * The actual screenshot capture and visual summary generation are handled by
 * the caller (computer.ts) — this module only decides the response mode.
 */

import type { Page } from 'puppeteer-core';

interface ScreenshotRecord {
  scrollTop: number;
  scrollLeft: number;
  timestamp: number;
}

/** How close two scroll positions must be (in pixels) to count as "same" */
const POSITION_TOLERANCE_PX = 50;

/** Window within which repeated screenshots at the same position degrade (ms) */
const REPEAT_WINDOW_MS = 30_000;

/** How long before a record is pruned entirely (ms) */
const PRUNE_AGE_MS = 60_000;

const ANNOTATED_NOTE =
  'Note: No significant visual change detected since last screenshot at this scroll position.';

/**
 * Singleton that tracks screenshot history per tabId and returns the
 * appropriate response mode for each screenshot request.
 */
export class AdaptiveScreenshot {
  private static instance: AdaptiveScreenshot;

  /** tabId → ordered list of screenshot records (oldest first) */
  private history: Map<string, ScreenshotRecord[]> = new Map();

  private constructor() {}

  static getInstance(): AdaptiveScreenshot {
    if (!AdaptiveScreenshot.instance) {
      AdaptiveScreenshot.instance = new AdaptiveScreenshot();
    }
    return AdaptiveScreenshot.instance;
  }

  /**
   * Evaluate what response mode to use for the next screenshot on this tab.
   *
   * Reads the current scroll position from the page, prunes stale records,
   * counts how many recent screenshots have been taken at the same position,
   * then appends the new record and returns the mode.
   *
   * - 1st screenshot at a position → 'full'
   * - 2nd screenshot at same position (within ±50px, within 30s) → 'annotated'
   * - 3rd+ at same position → 'text_only'
   *
   * Fails gracefully: if page.evaluate throws, returns 'full'.
   */
  async evaluate(page: Page, tabId: string): Promise<'full' | 'annotated' | 'text_only'> {
    let scrollTop = 0;
    let scrollLeft = 0;

    try {
      const pos = await page.evaluate(() => ({
        scrollTop: window.scrollY,
        scrollLeft: window.scrollX,
      }));
      scrollTop = pos.scrollTop;
      scrollLeft = pos.scrollLeft;
    } catch {
      // Page not available or evaluate failed — default to full
      return 'full';
    }

    const now = Date.now();

    // Prune old entries for this tab
    this.pruneTab(tabId, now);

    const records = this.history.get(tabId) ?? [];

    // Count recent records at the same position
    const recentAtPosition = records.filter(
      (r) =>
        now - r.timestamp <= REPEAT_WINDOW_MS &&
        Math.abs(r.scrollTop - scrollTop) <= POSITION_TOLERANCE_PX &&
        Math.abs(r.scrollLeft - scrollLeft) <= POSITION_TOLERANCE_PX,
    );

    const count = recentAtPosition.length;

    // Append new record
    records.push({ scrollTop, scrollLeft, timestamp: now });
    this.history.set(tabId, records);

    if (count === 0) {
      return 'full';
    } else if (count === 1) {
      return 'annotated';
    } else {
      return 'text_only';
    }
  }

  /**
   * Returns the annotation note used when mode is 'annotated'.
   */
  getAnnotation(): string {
    return ANNOTATED_NOTE;
  }

  /**
   * Clear screenshot history for a tab (call on navigation).
   */
  reset(tabId: string): void {
    this.history.delete(tabId);
  }

  /**
   * Remove records older than PRUNE_AGE_MS for the given tab.
   */
  private pruneTab(tabId: string, now: number): void {
    const records = this.history.get(tabId);
    if (!records || records.length === 0) return;

    const pruned = records.filter((r) => now - r.timestamp < PRUNE_AGE_MS);

    if (pruned.length === 0) {
      this.history.delete(tabId);
    } else {
      this.history.set(tabId, pruned);
    }
  }
}
