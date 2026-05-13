/**
 * Vision Mode Configuration
 *
 * Controls when vision-based element discovery is used (#577).
 *
 * Modes:
 *   - 'off'      — Vision fallback completely disabled (default since #831)
 *   - 'fallback' — Vision used only when DOM discovery fails
 *   - 'auto'     — Vision automatically used alongside DOM discovery
 *
 * Set via OPENCHROME_VISION_MODE environment variable.
 *
 * #831 flip: default is now 'off'. Opt-in via `OPENCHROME_VISION_MODE=on`
 * (equivalent to 'fallback'), `OPENCHROME_VISION_MODE=fallback`, or
 * `OPENCHROME_VISION_MODE=auto`. Per-call `allow_vision_fallback: true`
 * also enables it without changing the global default.
 */

import type { VisionMode } from './types';

export function getVisionMode(): VisionMode {
  const env = process.env.OPENCHROME_VISION_MODE;
  if (env === 'auto') return 'auto';
  if (env === 'fallback' || env === 'on') return 'fallback';
  if (env === 'off') return 'off';
  // #831: default flipped to 'off' so a missing/unset env var disables
  // vision fallback unless the call explicitly opts in.
  return 'off';
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
