/**
 * Minimal PNG encoder used solely by the contracts test suite.
 *
 * Emits 8-bit RGBA PNG with filter type 0 (None) and a single IDAT chunk.
 * Production code never depends on this — it exists so we can build PNG
 * test fixtures in-memory without committing binary blobs.
 */

import { deflateSync } from 'zlib';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Encode an 8-bit RGBA pixel buffer (row-major, length = width*height*4).
 */
export function encodeRgbaPng(width: number, height: number, rgba: Buffer | Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `encodeRgbaPng: expected ${width * height * 4} bytes, got ${rgba.length}`,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 6;        // colour type: truecolour + alpha
  ihdr[10] = 0;       // compression
  ihdr[11] = 0;       // filter
  ihdr[12] = 0;       // interlace

  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0; // filter: None
    Buffer.from(rgba.subarray(y * stride, (y + 1) * stride)).copy(
      filtered,
      y * (stride + 1) + 1,
    );
  }
  const idat = deflateSync(filtered);
  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Build a solid-colour RGBA buffer. */
export function solidRgba(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0];
    buf[i + 1] = rgba[1];
    buf[i + 2] = rgba[2];
    buf[i + 3] = rgba[3];
  }
  return buf;
}

/** Procedural gradient: useful for non-trivial pHash test vectors. */
export function gradientRgba(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      buf[idx] = Math.floor((x / width) * 255);
      buf[idx + 1] = Math.floor((y / height) * 255);
      buf[idx + 2] = Math.floor(((x + y) / (width + height)) * 255);
      buf[idx + 3] = 0xff;
    }
  }
  return buf;
}

/** Checkerboard for sharp-edge pHash signatures. */
export function checkerRgba(
  width: number,
  height: number,
  cell: number,
  black: [number, number, number, number] = [0, 0, 0, 255],
  white: [number, number, number, number] = [255, 255, 255, 255],
): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const isWhite = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0;
      const c = isWhite ? white : black;
      buf[idx] = c[0];
      buf[idx + 1] = c[1];
      buf[idx + 2] = c[2];
      buf[idx + 3] = c[3];
    }
  }
  return buf;
}
