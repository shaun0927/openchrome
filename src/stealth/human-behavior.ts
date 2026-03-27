/**
 * Human Behavior Simulation for Stealth Mode
 *
 * Generates human-like mouse movements, typing, and scrolling to bypass
 * behavioral telemetry analysis used by enterprise anti-bot systems
 * (Radware/ShieldSquare, PerimeterX, Akamai).
 *
 * All functions in this module are intended for stealth-mode pages only.
 */

import type { Page } from 'puppeteer-core';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Gaussian-like random delay between minMs and maxMs.
 * Uses Box-Muller transform to cluster values around the midpoint
 * rather than uniform distribution (which looks mechanical).
 */
export async function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const mid = (minMs + maxMs) / 2;
  const stddev = (maxMs - minMs) / 6; // 99.7% within range
  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  const value = Math.round(Math.max(minMs, Math.min(maxMs, mid + z * stddev)));
  return new Promise(resolve => setTimeout(resolve, value));
}

/**
 * Quadratic Bézier interpolation.
 * Returns a point at parameter t (0..1) along the curve defined by p0, p1 (control), p2.
 */
function bezierPoint(
  t: number,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): { x: number; y: number } {
  const inv = 1 - t;
  return {
    x: inv * inv * p0.x + 2 * inv * t * p1.x + t * t * p2.x,
    y: inv * inv * p0.y + 2 * inv * t * p1.y + t * t * p2.y,
  };
}

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

/**
 * Move the mouse along a Bézier curve from the current position to (toX, toY).
 * Produces 15-35 intermediate points with acceleration/deceleration and ±pixel jitter.
 */
export async function humanMouseMove(
  page: Page,
  toX: number,
  toY: number,
): Promise<void> {
  // Get current mouse position (default to a reasonable starting point)
  let fromX: number;
  let fromY: number;
  try {
    const pos = await page.evaluate(() => ({
      x: (window as any).__oc_mouseX ?? Math.round(window.innerWidth * 0.3),
      y: (window as any).__oc_mouseY ?? Math.round(window.innerHeight * 0.3),
    }));
    fromX = pos.x;
    fromY = pos.y;
  } catch {
    fromX = Math.round(400 + Math.random() * 200);
    fromY = Math.round(300 + Math.random() * 100);
  }

  const steps = 15 + Math.floor(Math.random() * 21); // 15-35 steps

  // Random control point for the Bézier curve — creates a natural arc
  const controlX = fromX + (toX - fromX) * (0.3 + Math.random() * 0.4)
    + (Math.random() - 0.5) * 120;
  const controlY = fromY + (toY - fromY) * (0.3 + Math.random() * 0.4)
    + (Math.random() - 0.5) * 120;

  const from = { x: fromX, y: fromY };
  const control = { x: controlX, y: controlY };
  const to = { x: toX, y: toY };

  for (let i = 0; i <= steps; i++) {
    // Ease-in-out parameterization: slow start, fast middle, slow end
    const linear = i / steps;
    const t = linear < 0.5
      ? 2 * linear * linear
      : 1 - Math.pow(-2 * linear + 2, 2) / 2;

    const pt = bezierPoint(t, from, control, to);

    // Add sub-pixel jitter (±1.5px) except for the last point
    const jitterX = i < steps ? (Math.random() - 0.5) * 3 : 0;
    const jitterY = i < steps ? (Math.random() - 0.5) * 3 : 0;

    await page.mouse.move(
      Math.round(pt.x + jitterX),
      Math.round(pt.y + jitterY),
    );

    // Variable delay: faster in the middle, slower at edges
    const speed = 1 - Math.abs(linear - 0.5) * 1.2; // 0.4..1.0
    const delayMs = 4 + Math.random() * 12 * (1 - speed * 0.6);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  // Track mouse position for next call
  await page.evaluate((x: number, y: number) => {
    (window as any).__oc_mouseX = x;
    (window as any).__oc_mouseY = y;
  }, toX, toY).catch(() => {});
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/**
 * Type text character-by-character with human-like inter-keystroke delays.
 * Adds longer pauses at word boundaries and occasional micro-pauses.
 */
export async function humanType(page: Page, text: string): Promise<void> {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    await page.keyboard.type(char);

    // Base delay: 30-150ms
    let delayMs = 30 + Math.random() * 120;

    // Longer pause at word boundaries (space, punctuation)
    if (char === ' ' || char === '.' || char === ',' || char === '\n') {
      delayMs += 50 + Math.random() * 150;
    }

    // Occasional micro-pause (thinking hesitation) ~5% of the time
    if (Math.random() < 0.05) {
      delayMs += 200 + Math.random() * 300;
    }

    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

// ---------------------------------------------------------------------------
// Scroll
// ---------------------------------------------------------------------------

/**
 * Scroll by deltaY using multiple wheel events with momentum physics.
 * Simulates fast initial scroll that decelerates gradually.
 */
export async function humanScroll(page: Page, deltaY: number): Promise<void> {
  const steps = 5 + Math.floor(Math.random() * 8); // 5-12 wheel events
  const direction = Math.sign(deltaY);
  const totalDelta = Math.abs(deltaY);

  // Momentum distribution: large deltas first, decelerating
  const weights: number[] = [];
  let weightSum = 0;
  for (let i = 0; i < steps; i++) {
    // Exponential decay: 1.0, 0.7, 0.49, ...
    const w = Math.pow(0.7, i) + Math.random() * 0.2;
    weights.push(w);
    weightSum += w;
  }

  for (let i = 0; i < steps; i++) {
    const fraction = weights[i] / weightSum;
    const stepDelta = Math.round(totalDelta * fraction) * direction;

    // Add small horizontal wobble (humans don't scroll perfectly vertical)
    const deltaX = Math.round((Math.random() - 0.5) * 4);

    await page.mouse.wheel({ deltaY: stepDelta, deltaX });

    // Faster at start, slower at end
    const baseDelay = 20 + (i / steps) * 60;
    await new Promise(resolve => setTimeout(resolve, baseDelay + Math.random() * 30));
  }
}

// ---------------------------------------------------------------------------
// Presence Simulation
// ---------------------------------------------------------------------------

/**
 * Simulate human presence after stealth navigation.
 * Performs 2-3 random mouse movements and a small scroll.
 * Should be called after createTargetStealth() completes.
 *
 * Total duration: ~2-4 seconds.
 */
export async function simulatePresence(page: Page): Promise<void> {
  try {
    // Get viewport dimensions
    const viewport = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));

    const w = viewport.w || 1920;
    const h = viewport.h || 1080;

    // 2-3 random mouse movements in the visible area
    const moveCount = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < moveCount; i++) {
      // Stay within the center 60% of the viewport (avoid edges)
      const targetX = Math.round(w * 0.2 + Math.random() * w * 0.6);
      const targetY = Math.round(h * 0.2 + Math.random() * h * 0.6);
      await humanMouseMove(page, targetX, targetY);
      await humanDelay(300, 800);
    }

    // Small scroll down (100-300px)
    const scrollAmount = 100 + Math.floor(Math.random() * 200);
    await humanScroll(page, scrollAmount);

    // Brief pause before handing control back
    await humanDelay(200, 600);
  } catch (err) {
    // Non-critical — don't break navigation if presence simulation fails
    console.error(`[stealth] simulatePresence failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
