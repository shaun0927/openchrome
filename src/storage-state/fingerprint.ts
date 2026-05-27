/**
 * Profile fingerprint — deterministic, secret-free hash of a captured
 * storage-state envelope (issue: B3-PR1 of #1359 host-neutral harness).
 *
 * A fingerprint lets two parties verify "is this the same logged-in session?"
 * *without* either side seeing the cookie or storage values. Inputs that
 * enter the hash are limited to **shape, not contents**:
 *
 *   - For each cookie: `name`, `domain`, `path`, `httpOnly`, `secure`,
 *     `sameSite`, the **length** of the value (never the value), and a
 *     **bucketed** expiry (rounded down to the hour, in seconds).
 *   - For each storage entry: `key` and the **length** of the value.
 *   - `origin` (origins are not secrets).
 *
 * The cookie/storage values themselves are *never* fed into the hash. A
 * negative test in `fingerprint.test.ts` codifies this property: changing
 * only the values must not change the fingerprint.
 *
 * Canonical JSON serialization is used so the same inputs produce the same
 * hash across machines:
 *
 *   - Object keys are sorted (the JSON object spec is unordered; we pick a
 *     stable order).
 *   - Cookie / storage entries are pre-sorted before serialization.
 *   - `JSON.stringify` is called with no whitespace argument.
 *
 * The output is wrapped in a versioned envelope so that any future change
 * to the canonical form gets a new `version` and old fingerprints remain
 * recognizable.
 *
 * Pure function. Zero I/O. Zero Chrome dependency.
 *
 * @see docs/storage-state/fingerprint-spec.md
 * @see #1359 Pillar B (profile/auth reuse), Pillar D (portable memory)
 */

import { createHash } from 'node:crypto';
import type { EnvelopeCapture } from './storage-state-manager';

/** Bucket size (seconds) for the cookie expiry input. */
const EXPIRY_BUCKET_SECONDS = 3600;

/** Format version of the canonical fingerprint. */
export const FINGERPRINT_VERSION = 1 as const;

/** Hash algorithm name. */
export const FINGERPRINT_ALGORITHM = 'sha256' as const;

export interface FingerprintBreakdown {
  /** Number of cookies summarized. */
  cookies: number;
  /** Number of localStorage keys summarized. */
  localStorageKeys: number;
  /** Number of sessionStorage keys summarized. */
  sessionStorageKeys: number;
  /** The origin string used in the hash. */
  origin: string;
}

export interface ProfileFingerprint {
  version: typeof FINGERPRINT_VERSION;
  algorithm: typeof FINGERPRINT_ALGORITHM;
  /** Lowercase hex digest of the canonical-JSON summary. */
  hash: string;
  /** Non-secret summary counts. Useful for diagnostics and trace bundles. */
  breakdown: FingerprintBreakdown;
}

interface CookieSummary {
  readonly name: string;
  readonly domain: string;
  readonly path: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: string;
  readonly valueLength: number;
  /**
   * Cookie expiry, bucketed to the hour. `-1` is used for session cookies
   * (no expiry). Bucketing keeps the fingerprint stable across small
   * timing differences in capture.
   */
  readonly expiryBucket: number;
}

interface StorageSummary {
  readonly key: string;
  readonly valueLength: number;
}

interface CanonicalSummary {
  readonly version: typeof FINGERPRINT_VERSION;
  readonly origin: string;
  readonly cookies: readonly CookieSummary[];
  readonly localStorage: readonly StorageSummary[];
  readonly sessionStorage: readonly StorageSummary[];
}

function bucketExpiry(expires: number | undefined): number {
  if (expires === undefined || expires === null) return -1;
  // Cookies' `expires` is a Unix epoch in seconds. Treat <= 0 as session.
  if (!Number.isFinite(expires) || expires <= 0) return -1;
  return Math.floor(expires / EXPIRY_BUCKET_SECONDS) * EXPIRY_BUCKET_SECONDS;
}

function summarizeCookies(
  cookies: EnvelopeCapture['cookies'] | undefined,
): CookieSummary[] {
  if (!cookies) return [];
  const out: CookieSummary[] = [];
  for (const c of cookies) {
    const value = typeof c.value === 'string' ? c.value : '';
    out.push({
      name: c.name,
      domain: c.domain,
      path: c.path,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: typeof c.sameSite === 'string' ? c.sameSite : '',
      valueLength: value.length,
      expiryBucket: bucketExpiry(c.expires),
    });
  }
  // Sort lexicographically by (domain, name, path) for determinism.
  out.sort((a, b) => {
    if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return 0;
  });
  return out;
}

function summarizeStorage(
  store: Record<string, string> | undefined,
): StorageSummary[] {
  if (!store) return [];
  const keys = Object.keys(store).sort();
  return keys.map(k => ({ key: k, valueLength: (store[k] ?? '').length }));
}

/**
 * Canonical JSON encoder for the summary. We do NOT use a generic
 * canonicalizer because our shape is closed; emitting keys in a fixed
 * order is sufficient and avoids a dependency.
 */
function encodeCanonical(summary: CanonicalSummary): string {
  // Build the object with a fixed key order, then JSON.stringify. Because
  // the summary type is closed and every nested array element has a fixed
  // key order too, this produces a byte-identical string for identical
  // inputs across V8 versions.
  const cookieObjects = summary.cookies.map(c => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
    valueLength: c.valueLength,
    expiryBucket: c.expiryBucket,
  }));
  const localObjects = summary.localStorage.map(s => ({ key: s.key, valueLength: s.valueLength }));
  const sessionObjects = summary.sessionStorage.map(s => ({ key: s.key, valueLength: s.valueLength }));

  return JSON.stringify({
    version: summary.version,
    origin: summary.origin,
    cookies: cookieObjects,
    localStorage: localObjects,
    sessionStorage: sessionObjects,
  });
}

/**
 * Compute the fingerprint of a storage-state envelope.
 *
 * Idempotent and side-effect-free. Returns the structured fingerprint —
 * the hex `hash` field is what callers compare; the `breakdown` is a
 * non-secret diagnostic aid (e.g. "we hashed 12 cookies and 3 localStorage
 * keys for `https://example.com`").
 */
export function fingerprintEnvelope(capture: EnvelopeCapture): ProfileFingerprint {
  const cookies = summarizeCookies(capture.cookies);
  const localStorageEntries = summarizeStorage(capture.localStorage);
  const sessionStorageEntries = summarizeStorage(capture.sessionStorage);
  const summary: CanonicalSummary = {
    version: FINGERPRINT_VERSION,
    origin: typeof capture.origin === 'string' ? capture.origin : '',
    cookies,
    localStorage: localStorageEntries,
    sessionStorage: sessionStorageEntries,
  };

  const canonical = encodeCanonical(summary);
  const hash = createHash(FINGERPRINT_ALGORITHM).update(canonical, 'utf8').digest('hex');

  return {
    version: FINGERPRINT_VERSION,
    algorithm: FINGERPRINT_ALGORITHM,
    hash,
    breakdown: {
      cookies: cookies.length,
      localStorageKeys: localStorageEntries.length,
      sessionStorageKeys: sessionStorageEntries.length,
      origin: summary.origin,
    },
  };
}
