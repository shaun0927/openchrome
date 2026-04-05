/**
 * Vision Auto-Detection
 *
 * Detects page conditions where vision-based element discovery would be
 * more effective than DOM-based approaches (#577 Phase 3).
 */

import type { Page } from 'puppeteer-core';
import type { VisionHint } from './types';

/**
 * Detect conditions that suggest vision-based approach would be more effective.
 * Returns hints sorted by confidence (high -> low).
 */
export async function detectVisionHints(page: Page): Promise<VisionHint[]> {
  const hints: VisionHint[] = [];

  try {
    const pageInfo = await page.evaluate(() => {
      const canvasElements = document.querySelectorAll('canvas');
      const hasLargeCanvas = Array.from(canvasElements).some(c => {
        const rect = c.getBoundingClientRect();
        return rect.width > 200 && rect.height > 200;
      });

      const iframes = document.querySelectorAll('iframe');
      const crossOriginIframes = Array.from(iframes).filter(f => {
        try { return f.contentDocument === null; } catch { return true; }
      });

      // Count interactive elements for sparse AX detection
      const interactiveSelectors = 'button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"]';
      const interactiveCount = document.querySelectorAll(interactiveSelectors).length;
      const totalElements = document.querySelectorAll('*').length;

      return {
        hasLargeCanvas,
        canvasCount: canvasElements.length,
        crossOriginIframeCount: crossOriginIframes.length,
        interactiveCount,
        totalElements,
      };
    });

    if (pageInfo.hasLargeCanvas) {
      hints.push({
        reason: `Page contains ${pageInfo.canvasCount} canvas element(s) with significant size — DOM has no useful structure for canvas content`,
        confidence: 'high',
        source: 'canvas',
      });
    }

    if (pageInfo.crossOriginIframeCount > 0) {
      hints.push({
        reason: `Page contains ${pageInfo.crossOriginIframeCount} cross-origin iframe(s) — DOM is inaccessible`,
        confidence: 'medium',
        source: 'iframe',
      });
    }

    // Sparse AX: visually complex page but few interactive elements found
    if (pageInfo.totalElements > 100 && pageInfo.interactiveCount < 5) {
      hints.push({
        reason: `Page has ${pageInfo.totalElements} elements but only ${pageInfo.interactiveCount} interactive — possible obfuscated or custom UI`,
        confidence: 'medium',
        source: 'sparse-ax',
      });
    }
  } catch {
    // Page evaluation failed — can't detect hints
  }

  // Sort by confidence: high > medium > low
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return hints.sort((a, b) => order[a.confidence] - order[b.confidence]);
}

/**
 * Check if the circuit breaker suggests switching to vision mode.
 * Returns a hint if repeated DOM failures have been recorded for this tab.
 */
export function checkRepeatedFailures(
  tabId: string,
  checkPageFn: (tabId: string) => { state: string; failures: number }
): VisionHint | null {
  const status = checkPageFn(tabId);
  if (status.failures >= 3) {
    return {
      reason: `${status.failures} DOM-based failures on this tab — vision may be more effective`,
      confidence: status.state === 'OPEN' ? 'high' : 'medium',
      source: 'repeated-failure',
    };
  }
  return null;
}

/**
 * Format hints as a user-friendly suggestion string.
 */
export function formatVisionHints(hints: VisionHint[]): string {
  if (hints.length === 0) return '';
  const lines = hints.map(h => `  [${h.confidence}] ${h.reason}`);
  return `Vision mode suggested:\n${lines.join('\n')}`;
}
