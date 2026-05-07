/**
 * Handoff token utilities.
 *
 * Per #708 v2:
 *   - Generation: `crypto.randomBytes(32).toString('hex')` ⇒ 64-char hex.
 *   - Validation: `crypto.timingSafeEqual` against the stored token.
 *   - Single-use: tokens are rotated on each new handoff attempt within
 *     the same transaction; the manager (`./manager.ts`) enforces.
 *   - Storage at rest: caller chooses (PR-15 wires keychain on
 *     macOS/Windows and AES-256-GCM on Linux). This module deals only
 *     with the token bytes themselves.
 */

import * as crypto from 'node:crypto';

const TOKEN_BYTES = 32;
const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;

/** Generate a fresh handoff token (64-char hex). */
export function generateHandoffToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Timing-safe comparison of a candidate token against the expected one.
 * Returns false (without throwing) for malformed or wrong-length input.
 */
export function verifyHandoffToken(candidate: string, expected: string): boolean {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  if (candidate.length !== TOKEN_HEX_LENGTH || expected.length !== TOKEN_HEX_LENGTH) return false;
  if (!/^[0-9a-f]+$/i.test(candidate) || !/^[0-9a-f]+$/i.test(expected)) return false;
  // Buffer.from is safe here — both inputs are validated as fixed-length hex.
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Length of a valid hex-encoded handoff token. Exposed for tests + docs. */
export const HANDOFF_TOKEN_HEX_LENGTH = TOKEN_HEX_LENGTH;
