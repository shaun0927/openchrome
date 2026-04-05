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
