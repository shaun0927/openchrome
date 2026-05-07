import {
  MAX_CAPTURE_AREA_PIXELS,
  MAX_INLINE_IMAGE_PAYLOAD_BYTES,
} from '../config/defaults';

export { MAX_CAPTURE_AREA_PIXELS, MAX_INLINE_IMAGE_PAYLOAD_BYTES };

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
