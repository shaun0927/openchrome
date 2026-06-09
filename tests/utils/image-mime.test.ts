/// <reference types="jest" />

import {
  detectImageMimeType,
  detectImageMimeTypeFromBase64,
  coerceSupportedImageMimeType,
  makeImageContent,
  normalizeImageMimeType,
} from '../../src/utils/image-mime';

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]);
const webpBytes = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
]);

describe('image MIME helpers', () => {
  it('detects PNG, JPEG, and WebP from strict magic bytes', () => {
    expect(detectImageMimeType(pngBytes)).toBe('image/png');
    expect(detectImageMimeType(jpegBytes)).toBe('image/jpeg');
    expect(detectImageMimeType(webpBytes)).toBe('image/webp');
  });

  it('returns undefined for unknown bytes', () => {
    expect(detectImageMimeType(Buffer.from('not-an-image'))).toBeUndefined();
  });

  it('coerces arbitrary MIME input to the supported MCP image set', () => {
    expect(coerceSupportedImageMimeType('image/webp')).toBe('image/webp');
    expect(coerceSupportedImageMimeType('application/octet-stream')).toBe('image/png');
    expect(coerceSupportedImageMimeType(undefined, 'image/webp')).toBe('image/webp');
  });

  it('normalizes declared MIME from actual base64 bytes', () => {
    const pngBase64 = pngBytes.toString('base64');
    expect(detectImageMimeTypeFromBase64(pngBase64)).toBe('image/png');
    expect(normalizeImageMimeType(pngBase64, 'image/webp')).toBe('image/png');
  });

  it('builds self-consistent MCP image content while preserving fallback MIME for unknown bytes', () => {
    expect(makeImageContent(pngBytes.toString('base64'), 'image/webp')).toEqual({
      type: 'image',
      data: pngBytes.toString('base64'),
      mimeType: 'image/png',
    });

    const unknown = Buffer.from('base64-screenshot-data').toString('base64');
    expect(makeImageContent(unknown, 'image/webp')).toEqual({
      type: 'image',
      data: unknown,
      mimeType: 'image/webp',
    });
  });
});
