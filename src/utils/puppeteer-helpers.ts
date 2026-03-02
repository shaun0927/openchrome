import type { Target } from 'puppeteer-core';

/**
 * Extract the internal CDP target ID from a Puppeteer Target.
 * Uses an internal property — centralized here so there is only one place to update
 * if Puppeteer changes the internal API.
 */
export function getTargetId(target: Target): string {
  return (target as unknown as { _targetId: string })._targetId;
}
