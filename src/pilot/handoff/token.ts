/**
 * Handoff token utilities (Phase 3, issue #793).
 *
 * Pilot-tier primitive that lets an MCP client transfer browser-session
 * ownership to another agent. This module deals only with the token bytes
 * and the structured payload that accompanies them:
 *
 *   - Generation: 32 bytes from `node:crypto` randomBytes, encoded with
 *     base64url (URL-safe, no padding). Yields a 43-character ASCII token.
 *   - Verification: `crypto.timingSafeEqual` after structural length /
 *     charset validation, so a malformed candidate cannot leak timing
 *     information about a stored token.
 *   - Single-use: the manager (`./manager.ts`) enforces — `redeem()`
 *     removes the entry on success and refuses subsequent attempts.
 *
 * Storage at rest is out of scope for this PR — issue #794 will land
 * keychain / AES-256-GCM persistence on top of the in-memory registry.
 * See docs/roadmap/portability-harness-contract.md "Handoff token
 * encryption" for the persistence design.
 */

import * as crypto from 'node:crypto';

/** Number of random bytes that back a handoff token. */
export const HANDOFF_TOKEN_BYTES = 32;
/** Length of the resulting base64url string (no padding). */
export const HANDOFF_TOKEN_LENGTH = Math.ceil((HANDOFF_TOKEN_BYTES * 4) / 3);
/** base64url charset, used to reject obviously malformed candidates early. */
const TOKEN_CHARSET = /^[A-Za-z0-9_-]+$/;
/** Default time-to-live for a freshly minted token. 5 minutes. */
export const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

export interface CreateHandoffTokenArgs {
  /** Browser session being transferred. Required. */
  sessionId: string;
  /**
   * Caller-defined scope label (e.g. "checkout", "read-only"). Free-form;
   * the manager surfaces it back when the token is redeemed so the receiving
   * agent can branch on it without a separate side-channel.
   */
  scope: string;
  /**
   * Optional explicit TTL in ms. Falls back to {@link DEFAULT_TOKEN_TTL_MS}.
   * Non-finite, zero or negative inputs are coerced to the default rather
   * than silently producing an already-expired token.
   */
  ttlMs?: number;
  /** Test hook: clock override. */
  now?: () => number;
}

export interface HandoffTokenResult {
  /** Base64url-encoded random 32 bytes. URL-safe, no padding. */
  token: string;
  /** Wall-clock ms (epoch) at which the token becomes invalid. */
  expiresAt: number;
}

/**
 * Mint a fresh handoff token. Pure — does not register the token with
 * any manager. Callers that want lifecycle tracking should hand the
 * result to {@link HandoffManager.register}.
 */
export function createHandoffToken(args: CreateHandoffTokenArgs): HandoffTokenResult {
  if (typeof args.sessionId !== 'string' || args.sessionId.length === 0) {
    throw new Error('createHandoffToken: sessionId is required');
  }
  if (typeof args.scope !== 'string' || args.scope.length === 0) {
    throw new Error('createHandoffToken: scope is required');
  }
  const ttl = normalizeTtl(args.ttlMs);
  const now = (args.now ?? Date.now)();
  return {
    token: crypto.randomBytes(HANDOFF_TOKEN_BYTES).toString('base64url'),
    expiresAt: now + ttl,
  };
}

/**
 * Timing-safe comparison of a candidate token against the expected one.
 * Returns false (without throwing) for malformed, wrong-charset, or
 * wrong-length input so callers do not need to wrap this in a try/catch.
 */
export function verifyHandoffToken(candidate: string, expected: string): boolean {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  if (candidate.length !== expected.length) return false;
  if (candidate.length !== HANDOFF_TOKEN_LENGTH) return false;
  if (!TOKEN_CHARSET.test(candidate) || !TOKEN_CHARSET.test(expected)) return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeTtl(ms: number | undefined): number {
  if (ms === undefined) return DEFAULT_TOKEN_TTL_MS;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return DEFAULT_TOKEN_TTL_MS;
  }
  return Math.floor(ms);
}
