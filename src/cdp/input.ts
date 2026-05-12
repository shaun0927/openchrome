/**
 * CDP Input helpers — shared coordinate-based mouse dispatch
 *
 * Extracted from ralph-engine.ts S3 strategy so both the interact
 * coordinate mode and the ralph waterfall share a single implementation.
 */

import type { Page } from 'puppeteer-core';
import type { CDPClient } from './client';

/** Modifier key → CDP bitfield (CDP standard: alt=1, ctrl=2, meta=4, shift=8) */
const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8,
};

export interface CoordinateClickOptions {
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  modifiers?: Array<'alt' | 'ctrl' | 'meta' | 'shift'>;
}

/**
 * Dispatch a coordinate click via CDP Input.dispatchMouseEvent.
 *
 * Sends mousePressed then mouseReleased — bypasses Puppeteer's isTrusted
 * handling and works inside Shadow DOM, <canvas>, and cross-origin iframes.
 */
export async function dispatchCoordinateClick(
  cdpClient: CDPClient,
  page: Page,
  opts: CoordinateClickOptions,
): Promise<void> {
  const { x, y } = opts;
  const button = opts.button ?? 'left';
  const clickCount = opts.clickCount ?? 1;
  const modifiers = opts.modifiers ?? [];

  const modifierBitfield = modifiers.reduce(
    (acc, mod) => acc | (MODIFIER_BITS[mod] ?? 0),
    0,
  );

  const base = {
    x,
    y,
    button,
    clickCount,
    modifiers: modifierBitfield,
  };

  await cdpClient.send(page, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...base,
  });
  await cdpClient.send(page, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...base,
  });
}
