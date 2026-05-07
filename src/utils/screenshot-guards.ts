import {
  MAX_CAPTURE_AREA_PIXELS,
  MAX_INLINE_IMAGE_PAYLOAD_BYTES,
} from '../config/defaults';
import { withTimeout } from './with-timeout';

export { MAX_CAPTURE_AREA_PIXELS, MAX_INLINE_IMAGE_PAYLOAD_BYTES };

/** Default fallback when viewport cannot be determined live (matches existing call sites). */
export const FALLBACK_VIEWPORT_DIMENSIONS: CaptureDimensions = { width: 1920, height: 1080 };

/** Maximum time to wait for live viewport dimension lookup via page.evaluate. */
export const VIEWPORT_DIMENSION_LOOKUP_TIMEOUT_MS = 5000;

/**
 * Subset of the puppeteer Page API needed to resolve viewport dimensions.
 * Duck-typed to keep this util free of a direct puppeteer-core dependency.
 */
export interface ViewportLookupPage {
  viewport(): { width: number; height: number } | null;
  evaluate<T>(pageFunction: () => T | Promise<T>): Promise<T>;
}

/**
 * Resolve the live viewport dimensions for the area guard.
 *
 * page.viewport() returns null when Chrome is launched with
 * `defaultViewport: null` (see src/cdp/client.ts), so a hardcoded fallback
 * cannot reflect the real window size when --window-size is large. Read the
 * live `window.innerWidth/innerHeight` via page.evaluate (with a short
 * timeout so a hung renderer cannot block the screenshot pipeline) and only
 * fall back to a hardcoded default if both sources fail.
 */
export async function resolveViewportDimensions(
  page: ViewportLookupPage,
  timeoutMs: number = VIEWPORT_DIMENSION_LOOKUP_TIMEOUT_MS
): Promise<CaptureDimensions> {
  const v = page.viewport();
  if (v && v.width > 0 && v.height > 0) {
    return { width: v.width, height: v.height };
  }
  try {
    const live = await withTimeout(
      page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      })),
      timeoutMs,
      'Viewport dimension lookup'
    );
    if (live && Number.isFinite(live.width) && Number.isFinite(live.height) && live.width > 0 && live.height > 0) {
      return { width: live.width, height: live.height };
    }
  } catch {
    // Renderer hung or unresponsive — fall through to the hardcoded fallback.
  }
  return { ...FALLBACK_VIEWPORT_DIMENSIONS };
}

export interface CaptureDimensions {
  width: number;
  height: number;
}

export function getCaptureAreaPixels(dimensions: CaptureDimensions): number {
  return dimensions.width * dimensions.height;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MiB`;
  }
  return `${Math.round(bytes / 1024)} KiB`;
}

export function validateCaptureArea(
  dimensions: CaptureDimensions,
  label = 'Screenshot'
): string | undefined {
  const area = getCaptureAreaPixels(dimensions);
  if (area <= MAX_CAPTURE_AREA_PIXELS) return undefined;

  return `${label} area ${dimensions.width}x${dimensions.height} (${area.toLocaleString()} pixels) exceeds the ${MAX_CAPTURE_AREA_PIXELS.toLocaleString()} pixel capture limit. Request viewport-only capture, use a smaller clip, or lower the page dimensions before retrying.`;
}

export function getBase64EncodedByteLength(data: string): number {
  return Buffer.byteLength(data, 'utf8');
}

export function validateInlineImagePayload(
  encodedByteLength: number,
  label = 'Screenshot'
): string | undefined {
  if (encodedByteLength <= MAX_INLINE_IMAGE_PAYLOAD_BYTES) return undefined;

  return `${label} inline payload is ${formatBytes(encodedByteLength)} after base64 encoding, which exceeds the ${formatBytes(MAX_INLINE_IMAGE_PAYLOAD_BYTES)} inline limit. Use the path parameter to save the image to a file, request viewport-only capture, use a smaller clip, or lower the page dimensions before retrying.`;
}

export function getBase64EncodedByteLengthForRawBytes(rawByteLength: number): number {
  return Math.ceil(rawByteLength / 3) * 4;
}

export function bufferToBase64WithPayloadGuard(
  buffer: Buffer,
  label = 'Screenshot'
): { data: string; error?: never } | { data?: never; error: string } {
  const encodedByteLength = getBase64EncodedByteLengthForRawBytes(buffer.byteLength);
  const error = validateInlineImagePayload(encodedByteLength, label);
  if (error) return { error };
  return { data: buffer.toString('base64') };
}
