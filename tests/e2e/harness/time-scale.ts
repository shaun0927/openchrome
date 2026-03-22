/**
 * TIME_SCALE — CI time compression for E2E tests.
 *
 * CI uses TIME_SCALE=0.167 (6x compression) to run 60-min marathon in ~10min.
 * Local dev uses TIME_SCALE=1 (full duration) by default.
 */

const TIME_SCALE = parseFloat(process.env.TIME_SCALE || '1');

/**
 * Scale a duration by TIME_SCALE factor.
 * @param ms - Duration in milliseconds at full scale
 * @returns Scaled duration in milliseconds
 */
export function scaled(ms: number): number {
  return Math.round(ms * TIME_SCALE);
}

/**
 * Sleep for a scaled duration.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep for a scaled duration (applies TIME_SCALE).
 */
export function scaledSleep(ms: number): Promise<void> {
  return sleep(scaled(ms));
}

/** Fixed overhead buffer for Jest timeout (not scaled). Accounts for test runner setup/teardown. */
export const JEST_OVERHEAD_MS = 30_000;

export { TIME_SCALE };
