/**
 * TOTP Manager - RFC 6238 Time-Based One-Time Password generation
 * Uses Node.js built-in crypto module only (no external dependencies)
 */
import * as crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Validate that a string is a valid base32-encoded secret
 */
export function validateBase32(secret: string): boolean {
  if (!secret || secret.length === 0) return false;
  // Remove padding and whitespace, uppercase
  const normalized = secret.toUpperCase().replace(/\s/g, '').replace(/=+$/, '');
  if (normalized.length === 0) return false;
  return /^[A-Z2-7]+$/.test(normalized);
}

/**
 * Decode a base32-encoded string to a Buffer
 */
export function base32Decode(encoded: string): Buffer {
  const normalized = encoded.toUpperCase().replace(/\s/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (let i = 0; i < normalized.length; i++) {
    const charIndex = BASE32_ALPHABET.indexOf(normalized[i]);
    if (charIndex === -1) {
      throw new Error(`Invalid base32 character: ${normalized[i]}`);
    }
    // Accumulate 5 bits per base32 character
    value = (value << 5) | charIndex;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >> bits) & 0xff);
    }
  }

  return Buffer.from(output);
}

/**
 * Compute HMAC digest
 */
export function hmacDigest(algorithm: string, key: Buffer, counter: Buffer): Buffer {
  const hmac = crypto.createHmac(algorithm.toLowerCase(), key);
  hmac.update(counter);
  return hmac.digest();
}

/**
 * RFC 4226 dynamic truncation: extract a 31-bit integer from HMAC output
 */
export function dynamicTruncation(hmac: Buffer): number {
  // Use the last nibble as the offset
  const offset = hmac[hmac.length - 1] & 0x0f;
  // Extract 4 bytes at that offset, mask the most significant bit
  return (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  );
}

export interface TOTPOptions {
  /** Time step in seconds (default: 30) */
  period?: number;
  /** Number of digits in the OTP (default: 6) */
  digits?: number;
  /** HMAC algorithm (default: 'sha1') */
  algorithm?: string;
  /** Time offset in steps for clock drift correction (e.g. -1, 0, 1) */
  timeOffset?: number;
}

/**
 * Generate a TOTP code from a base32-encoded secret (RFC 6238)
 *
 * @param secret - base32-encoded TOTP secret
 * @param options - optional overrides for period, digits, algorithm, timeOffset
 * @returns zero-padded OTP string of length `digits`
 */
export function generateTOTP(secret: string, options?: TOTPOptions): string {
  const period = options?.period ?? 30;
  const digits = options?.digits ?? 6;
  const algorithm = options?.algorithm ?? 'sha1';
  const timeOffset = options?.timeOffset ?? 0;

  // Decode base32 secret to raw key bytes
  const key = base32Decode(secret);

  // Compute the time step counter (T0 = Unix epoch, T = floor(now / period))
  const timeStep = Math.floor(Date.now() / 1000 / period) + timeOffset;

  // Encode counter as big-endian 8-byte buffer
  const counter = Buffer.alloc(8);
  // JavaScript bitwise ops are 32-bit, handle high/low words separately
  const high = Math.floor(timeStep / 0x100000000);
  const low = timeStep >>> 0;
  counter.writeUInt32BE(high, 0);
  counter.writeUInt32BE(low, 4);

  // Compute HMAC
  const hmac = hmacDigest(algorithm, key, counter);

  // Dynamic truncation
  const truncated = dynamicTruncation(hmac);

  // Compute OTP: truncated mod 10^digits, zero-padded
  const otp = truncated % Math.pow(10, digits);
  return otp.toString().padStart(digits, '0');
}
