/**
 * Portable signed snapshot envelope — v1 (B3-PR3 of #1359).
 *
 * Wraps an `EnvelopeCapture` (cookies + localStorage + sessionStorage +
 * origin) in a transport-portable record:
 *
 *   { version, fingerprint, captured_at, origin, payload, hmac? }
 *
 * Two parts compose the envelope:
 *
 *   1. The **fingerprint** (B3-PR1) — a secret-free hash of the
 *      payload's shape. Lets two parties compare envelopes without
 *      decrypting/inspecting the payload.
 *
 *   2. An optional **HMAC** over the canonical encoding of the
 *      envelope (excluding the `hmac` field itself) so the recipient
 *      can detect tampering. The key is **host-supplied** — neither
 *      the envelope module nor the broader openchrome boot path ever
 *      generates, stores, or requires an HMAC key. This keeps the
 *      module compliant with #1359 §P7 (no mandatory third-party
 *      credentials at boot).
 *
 * Pure functions, no I/O. The envelope can travel through MCP tool
 * input/output, evidence bundles, or external benchmark adapters
 * without code-mobility tricks — it's just JSON.
 *
 * Forward compatibility: a single `version` integer pins the canonical
 * shape. Any change to the shape requires bumping the version; v1
 * envelopes remain readable forever.
 *
 * @see docs/storage-state/fingerprint-spec.md
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  fingerprintEnvelope,
  type ProfileFingerprint,
} from './fingerprint';
import type { EnvelopeCapture } from './storage-state-manager';

/** Envelope format version. */
export const ENVELOPE_VERSION = 1 as const;

/** HMAC algorithm used when the host supplies a signing key. */
export const ENVELOPE_HMAC_ALGORITHM = 'sha256' as const;

export interface PortableSnapshotEnvelope {
  version: typeof ENVELOPE_VERSION;
  /** Shape hash from B3-PR1. Non-secret. */
  fingerprint: ProfileFingerprint;
  /** Epoch ms when the envelope was sealed. */
  captured_at: number;
  /** Origin from the capture. Echoed alongside the fingerprint for sanity. */
  origin: string;
  /** The original capture, verbatim. */
  payload: EnvelopeCapture;
  /**
   * Optional HMAC-SHA256 over the canonical encoding of the envelope
   * with `hmac` omitted. Present iff the host supplied a key.
   */
  hmac?: string;
}

export interface SealOptions {
  /** Epoch ms; defaults to Date.now(). */
  now?: number;
  /**
   * Optional HMAC signing key (Buffer or string). When supplied, the
   * sealed envelope carries an `hmac` field that downstream
   * recipients can verify with the same key.
   */
  hmacKey?: Buffer | string;
}

/**
 * Build a deterministic canonical encoding of the envelope for hashing.
 *
 * The encoding excludes the `hmac` field itself (otherwise verification
 * would chase its own tail) and uses a fixed key order so two callers
 * with the same inputs produce byte-identical bytes regardless of
 * V8 version or insertion order.
 *
 * The encoded shape is:
 *
 *   { version, captured_at, origin, fingerprint: { version, algorithm,
 *     hash, breakdown }, payload }
 */
function canonicalize(env: PortableSnapshotEnvelope): string {
  return JSON.stringify({
    version: env.version,
    captured_at: env.captured_at,
    origin: env.origin,
    fingerprint: {
      version: env.fingerprint.version,
      algorithm: env.fingerprint.algorithm,
      hash: env.fingerprint.hash,
      breakdown: env.fingerprint.breakdown,
    },
    payload: env.payload,
  });
}

function computeHmac(
  env: PortableSnapshotEnvelope,
  key: Buffer | string,
): string {
  const canonical = canonicalize(env);
  return createHmac(ENVELOPE_HMAC_ALGORITHM, key).update(canonical, 'utf8').digest('hex');
}

/**
 * Seal a capture into a portable envelope. Pure, idempotent given the
 * same `now` clock.
 *
 * When `opts.hmacKey` is supplied, the envelope carries an `hmac` field
 * computed over the canonical envelope encoding (excluding `hmac`
 * itself). Without a key, the envelope is unsigned — the fingerprint
 * still verifies shape, but tampering is undetectable. That trade-off
 * is the host's call; the module never auto-generates a key.
 */
export function sealEnvelope(
  capture: EnvelopeCapture,
  opts: SealOptions = {},
): PortableSnapshotEnvelope {
  const fp = fingerprintEnvelope(capture);
  const envelope: PortableSnapshotEnvelope = {
    version: ENVELOPE_VERSION,
    fingerprint: fp,
    captured_at: typeof opts.now === 'number' ? opts.now : Date.now(),
    origin: typeof capture.origin === 'string' ? capture.origin : '',
    payload: capture,
  };
  if (opts.hmacKey !== undefined) {
    envelope.hmac = computeHmac(envelope, opts.hmacKey);
  }
  return envelope;
}

export type VerifyResult =
  | { ok: true; envelope: PortableSnapshotEnvelope }
  | { ok: false; reason: VerifyFailureReason };

export type VerifyFailureReason =
  | 'unsupported_version'
  | 'fingerprint_mismatch'
  | 'hmac_missing'
  | 'hmac_mismatch'
  | 'hmac_key_missing'
  | 'malformed';

export interface VerifyOptions {
  /** Optional HMAC key. When supplied, the envelope must carry a matching `hmac`. */
  hmacKey?: Buffer | string;
  /** When true, treat an envelope with no `hmac` AND no provided key as a hard fail. */
  requireHmac?: boolean;
}

function isPortableEnvelope(value: unknown): value is PortableSnapshotEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<PortableSnapshotEnvelope>;
  return (
    v.version === ENVELOPE_VERSION &&
    typeof v.captured_at === 'number' &&
    typeof v.origin === 'string' &&
    !!v.fingerprint &&
    typeof v.fingerprint === 'object' &&
    typeof (v.fingerprint as ProfileFingerprint).hash === 'string' &&
    !!v.payload &&
    typeof v.payload === 'object'
  );
}

/**
 * Verify an envelope.
 *
 * Always recomputes the fingerprint over `payload` and compares to the
 * stored `fingerprint.hash`. When `opts.hmacKey` is supplied the
 * envelope's `hmac` is recomputed and compared in constant time.
 *
 * Returns a discriminated union so callers can branch on the precise
 * failure mode (e.g. surface "tampered" vs "stale shape" facts to the
 * host, per #1359 §P4).
 */
export function verifyEnvelope(
  raw: unknown,
  opts: VerifyOptions = {},
): VerifyResult {
  if (!isPortableEnvelope(raw)) return { ok: false, reason: 'malformed' };
  const env = raw;

  if (env.version !== ENVELOPE_VERSION) {
    return { ok: false, reason: 'unsupported_version' };
  }

  const fp = fingerprintEnvelope(env.payload);
  if (fp.hash !== env.fingerprint.hash) {
    return { ok: false, reason: 'fingerprint_mismatch' };
  }

  if (opts.requireHmac && !env.hmac && opts.hmacKey === undefined) {
    return { ok: false, reason: 'hmac_key_missing' };
  }

  if (env.hmac !== undefined) {
    if (opts.hmacKey === undefined) {
      return { ok: false, reason: 'hmac_key_missing' };
    }
    // Recompute over the envelope *without* the hmac field.
    const expected = computeHmac({ ...env, hmac: undefined }, opts.hmacKey);
    const a = Buffer.from(env.hmac, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: 'hmac_mismatch' };
    }
  } else if (opts.requireHmac) {
    return { ok: false, reason: 'hmac_missing' };
  }

  return { ok: true, envelope: env };
}
