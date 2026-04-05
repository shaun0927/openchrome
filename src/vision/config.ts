/**
 * Vision Mode Configuration
 *
 * Controls when vision-based element discovery is used (#577).
 *
 * Modes:
 *   - 'off'      — Vision fallback completely disabled
 *   - 'fallback' — Vision used only when DOM discovery fails (default)
 *   - 'auto'     — Vision automatically used alongside DOM discovery
 *
 * Set via OPENCHROME_VISION_MODE environment variable.
 */

import type { VisionMode } from './types';

export function getVisionMode(): VisionMode {
  const env = process.env.OPENCHROME_VISION_MODE;
  if (env === 'off' || env === 'auto') return env;
  return 'fallback';
}

// ─── Cost Tracking ───

let visionCallCount = 0;
let totalVisionTimeMs = 0;

export function trackVisionUsage(timeMs: number): void {
  visionCallCount++;
  totalVisionTimeMs += timeMs;
}

export function getVisionStats(): { calls: number; totalTimeMs: number } {
  return { calls: visionCallCount, totalTimeMs: totalVisionTimeMs };
}

export function resetVisionStats(): void {
  visionCallCount = 0;
  totalVisionTimeMs = 0;
}
