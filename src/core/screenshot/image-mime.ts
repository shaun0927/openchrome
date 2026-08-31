/**
 * Small image MIME helpers for MCP image content.
 *
 * The MCP image block's `mimeType` must describe the actual base64 bytes, not
 * merely the requested screenshot encoder. Keep this dependency-free and based
 * on strict file signatures so screenshot tools remain host-neutral.
 */

export type SupportedImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectImageMimeType(buffer: Buffer): SupportedImageMimeType | undefined {
  if (buffer.length >= PNG_MAGIC.length && PNG_MAGIC.every((byte, index) => buffer[index] === byte)) {
    return 'image/png';
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return undefined;
}

export function detectImageMimeTypeFromBase64(base64: string): SupportedImageMimeType | undefined {
  try {
    return detectImageMimeType(Buffer.from(base64, 'base64'));
  } catch {
    return undefined;
  }
}

export function coerceSupportedImageMimeType(
  value: string | undefined,
  fallback: SupportedImageMimeType = 'image/png'
): SupportedImageMimeType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' ? value : fallback;
}

export function normalizeImageMimeType(
  base64: string,
  declaredMimeType: SupportedImageMimeType
): SupportedImageMimeType {
  return detectImageMimeTypeFromBase64(base64) ?? declaredMimeType;
}

export function makeImageContent(
  base64: string,
  declaredMimeType: SupportedImageMimeType
): { type: 'image'; data: string; mimeType: SupportedImageMimeType } {
  return {
    type: 'image',
    data: base64,
    mimeType: normalizeImageMimeType(base64, declaredMimeType),
  };
}
