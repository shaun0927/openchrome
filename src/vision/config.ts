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


// ─── Perception Provider Configuration ───

export type VisionProviderName = 'dom' | 'omniparser-http';

export interface OmniParserProviderConfig {
  provider: VisionProviderName;
  endpointUrl?: string;
  timeoutMs: number;
  maxElements: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getOmniParserProviderConfig(): OmniParserProviderConfig {
  const rawProvider = (process.env.OPENCHROME_VISION_PROVIDER || 'dom').toLowerCase();
  const provider: VisionProviderName = rawProvider === 'omniparser-http' ? 'omniparser-http' : 'dom';
  return {
    provider,
    endpointUrl: process.env.OPENCHROME_OMNIPARSER_URL,
    timeoutMs: parsePositiveInt(process.env.OPENCHROME_OMNIPARSER_TIMEOUT_MS, 3000),
    maxElements: parsePositiveInt(process.env.OPENCHROME_OMNIPARSER_MAX_ELEMENTS, 200),
  };
}
