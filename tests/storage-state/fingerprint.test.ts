/// <reference types="jest" />

import {
  fingerprintEnvelope,
  FINGERPRINT_ALGORITHM,
  FINGERPRINT_VERSION,
} from '../../src/storage-state/fingerprint';
import type { EnvelopeCapture } from '../../src/storage-state/storage-state-manager';

const emptyCapture: EnvelopeCapture = {
  origin: 'https://example.com',
  cookies: [],
  localStorage: {},
  sessionStorage: {},
};

function makeCookie(overrides: Partial<EnvelopeCapture['cookies'][number]> = {}) {
  return {
    name: 'sid',
    value: 'secret-value',
    domain: '.example.com',
    path: '/',
    expires: 1_900_000_000,
    size: 4,
    httpOnly: true,
    secure: true,
    session: false,
    sameSite: 'Lax',
    ...overrides,
  };
}

describe('fingerprintEnvelope', () => {
  test('envelope structure carries version, algorithm, hash and breakdown', () => {
    const fp = fingerprintEnvelope(emptyCapture);
    expect(fp.version).toBe(FINGERPRINT_VERSION);
    expect(fp.algorithm).toBe(FINGERPRINT_ALGORITHM);
    expect(typeof fp.hash).toBe('string');
    expect(fp.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.breakdown).toEqual({
      cookies: 0,
      localStorageKeys: 0,
      sessionStorageKeys: 0,
      origin: 'https://example.com',
    });
  });

  test('determinism: repeated calls on the same capture produce the same hash', () => {
    const cap: EnvelopeCapture = {
      origin: 'https://example.com',
      cookies: [makeCookie()],
      localStorage: { a: '1', b: 'long-value' },
      sessionStorage: { z: 'zz' },
    };
    const a = fingerprintEnvelope(cap);
    const b = fingerprintEnvelope(cap);
    expect(a.hash).toBe(b.hash);
  });

  test('cookie VALUE never enters the hash (secret-free invariant)', () => {
    const base: EnvelopeCapture = {
      origin: 'https://example.com',
      cookies: [makeCookie({ value: 'A' })],
      localStorage: {},
      sessionStorage: {},
    };
    const alt: EnvelopeCapture = {
      origin: 'https://example.com',
      // Same length, different value
      cookies: [makeCookie({ value: 'B' })],
      localStorage: {},
      sessionStorage: {},
    };
    expect(fingerprintEnvelope(base).hash).toBe(fingerprintEnvelope(alt).hash);
  });

  test('changing cookie VALUE LENGTH changes the hash', () => {
    const base: EnvelopeCapture = {
      origin: 'https://example.com',
      cookies: [makeCookie({ value: 'short' })],
      localStorage: {},
      sessionStorage: {},
    };
    const longer: EnvelopeCapture = {
      origin: 'https://example.com',
      cookies: [makeCookie({ value: 'much-much-longer' })],
      localStorage: {},
      sessionStorage: {},
    };
    expect(fingerprintEnvelope(base).hash).not.toBe(fingerprintEnvelope(longer).hash);
  });

  test('changing cookie name or domain changes the hash', () => {
    const a: EnvelopeCapture = {
      ...emptyCapture,
      cookies: [makeCookie({ name: 'sid' })],
    };
    const renamed: EnvelopeCapture = {
      ...emptyCapture,
      cookies: [makeCookie({ name: 'sid2' })],
    };
    const cross: EnvelopeCapture = {
      ...emptyCapture,
      cookies: [makeCookie({ domain: '.other.com' })],
    };
    const hashA = fingerprintEnvelope(a).hash;
    expect(hashA).not.toBe(fingerprintEnvelope(renamed).hash);
    expect(hashA).not.toBe(fingerprintEnvelope(cross).hash);
  });

  test('cookie order independence: same set in different declaration order yields same hash', () => {
    const a: EnvelopeCapture = {
      ...emptyCapture,
      cookies: [
        makeCookie({ name: 'a' }),
        makeCookie({ name: 'b' }),
      ],
    };
    const b: EnvelopeCapture = {
      ...emptyCapture,
      cookies: [
        makeCookie({ name: 'b' }),
        makeCookie({ name: 'a' }),
      ],
    };
    expect(fingerprintEnvelope(a).hash).toBe(fingerprintEnvelope(b).hash);
  });

  test('storage VALUE never enters the hash, but KEY and LENGTH do', () => {
    const v1: EnvelopeCapture = {
      ...emptyCapture,
      localStorage: { token: 'AAAA' },
    };
    const v2_sameLen: EnvelopeCapture = {
      ...emptyCapture,
      localStorage: { token: 'BBBB' },
    };
    const v3_diffLen: EnvelopeCapture = {
      ...emptyCapture,
      localStorage: { token: 'BBBBB' },
    };
    const v4_diffKey: EnvelopeCapture = {
      ...emptyCapture,
      localStorage: { other: 'AAAA' },
    };
    expect(fingerprintEnvelope(v1).hash).toBe(fingerprintEnvelope(v2_sameLen).hash);
    expect(fingerprintEnvelope(v1).hash).not.toBe(fingerprintEnvelope(v3_diffLen).hash);
    expect(fingerprintEnvelope(v1).hash).not.toBe(fingerprintEnvelope(v4_diffKey).hash);
  });

  test('sessionStorage is hashed separately from localStorage', () => {
    const local: EnvelopeCapture = {
      ...emptyCapture,
      localStorage: { k: 'v' },
    };
    const session: EnvelopeCapture = {
      ...emptyCapture,
      sessionStorage: { k: 'v' },
    };
    expect(fingerprintEnvelope(local).hash).not.toBe(fingerprintEnvelope(session).hash);
  });

  test('changing origin changes the hash', () => {
    const a = fingerprintEnvelope({ ...emptyCapture, origin: 'https://example.com' });
    const b = fingerprintEnvelope({ ...emptyCapture, origin: 'https://other.com' });
    expect(a.hash).not.toBe(b.hash);
  });

  test('cookie expiry within the same hour bucket does NOT change the hash', () => {
    const baseExpiry = 1_900_000_000; // a known Unix second
    const sameBucket = baseExpiry + 60; // 60s later, still same hour
    const a: EnvelopeCapture = {
      ...emptyCapture,
      cookies: [makeCookie({ expires: baseExpiry })],
    };
    const b: EnvelopeCapture = {
      ...emptyCapture,
      cookies: [makeCookie({ expires: sameBucket })],
    };
    expect(fingerprintEnvelope(a).hash).toBe(fingerprintEnvelope(b).hash);
  });

  test('cookie expiry across a different hour bucket DOES change the hash', () => {
    const baseExpiry = 1_900_000_000;
    const differentBucket = baseExpiry + 3700; // > 1h later
    const a: EnvelopeCapture = {
      ...emptyCapture,
      cookies: [makeCookie({ expires: baseExpiry })],
    };
    const b: EnvelopeCapture = {
      ...emptyCapture,
      cookies: [makeCookie({ expires: differentBucket })],
    };
    expect(fingerprintEnvelope(a).hash).not.toBe(fingerprintEnvelope(b).hash);
  });

  test('session cookies (no expiry) collapse to the same bucket regardless of value', () => {
    const a: EnvelopeCapture = {
      ...emptyCapture,
      cookies: [makeCookie({ expires: -1, session: true })],
    };
    const b: EnvelopeCapture = {
      ...emptyCapture,
      cookies: [makeCookie({ expires: 0, session: true })],
    };
    expect(fingerprintEnvelope(a).hash).toBe(fingerprintEnvelope(b).hash);
  });

  test('breakdown counts match the input sizes', () => {
    const cap: EnvelopeCapture = {
      origin: 'https://example.com',
      cookies: [makeCookie({ name: 'a' }), makeCookie({ name: 'b' })],
      localStorage: { x: '1', y: '2', z: '3' },
      sessionStorage: { s: 'v' },
    };
    const fp = fingerprintEnvelope(cap);
    expect(fp.breakdown).toEqual({
      cookies: 2,
      localStorageKeys: 3,
      sessionStorageKeys: 1,
      origin: 'https://example.com',
    });
  });

  test('non-string origin is normalized to empty string in breakdown', () => {
    // Type-check escape hatch: callers may hand us a malformed capture.
    const fp = fingerprintEnvelope({
      origin: undefined as unknown as string,
      cookies: [],
      localStorage: {},
      sessionStorage: {},
    });
    expect(fp.breakdown.origin).toBe('');
    expect(fp.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
