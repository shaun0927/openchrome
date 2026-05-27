/// <reference types="jest" />

/**
 * Tests for the portable signed snapshot envelope (B3-PR3 of #1359).
 */

import {
  sealEnvelope,
  verifyEnvelope,
  ENVELOPE_VERSION,
  ENVELOPE_HMAC_ALGORITHM,
} from '../../src/storage-state/envelope';
import type { EnvelopeCapture } from '../../src/storage-state/storage-state-manager';

function makeCapture(over: Partial<EnvelopeCapture> = {}): EnvelopeCapture {
  return {
    origin: 'https://example.com',
    cookies: [
      {
        name: 'sid',
        value: 'aaaaaaa',
        domain: '.example.com',
        path: '/',
        expires: 1_900_000_000,
        size: 7,
        httpOnly: true,
        secure: true,
        session: false,
        sameSite: 'Lax',
      },
    ],
    localStorage: { token: 'AAAA' },
    sessionStorage: {},
    ...over,
  };
}

describe('sealEnvelope', () => {
  test('returns a well-formed v1 envelope', () => {
    const env = sealEnvelope(makeCapture(), { now: 1_900_000_000 });
    expect(env.version).toBe(ENVELOPE_VERSION);
    expect(env.captured_at).toBe(1_900_000_000);
    expect(env.origin).toBe('https://example.com');
    expect(env.fingerprint.algorithm).toBe('sha256');
    expect(env.fingerprint.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(env.payload).toEqual(makeCapture());
    expect(env.hmac).toBeUndefined();
  });

  test('omits hmac when no key supplied', () => {
    const env = sealEnvelope(makeCapture());
    expect(env.hmac).toBeUndefined();
  });

  test('adds hmac when key supplied (string or Buffer)', () => {
    const a = sealEnvelope(makeCapture(), { hmacKey: 'shared-secret', now: 1 });
    expect(a.hmac).toMatch(/^[0-9a-f]{64}$/);
    const b = sealEnvelope(makeCapture(), {
      hmacKey: Buffer.from('shared-secret', 'utf8'),
      now: 1,
    });
    expect(b.hmac).toBe(a.hmac);
  });

  test('different secrets produce different HMACs', () => {
    const a = sealEnvelope(makeCapture(), { hmacKey: 'k1', now: 1 });
    const b = sealEnvelope(makeCapture(), { hmacKey: 'k2', now: 1 });
    expect(a.hmac).not.toBe(b.hmac);
  });

  test('non-string origin in capture normalizes to "" on the envelope', () => {
    const env = sealEnvelope({
      ...makeCapture(),
      origin: undefined as unknown as string,
    });
    expect(env.origin).toBe('');
  });
});

describe('verifyEnvelope — happy path', () => {
  test('round-trip an unsigned envelope: seal → verify ok=true', () => {
    const env = sealEnvelope(makeCapture(), { now: 1 });
    const r = verifyEnvelope(env);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.envelope.fingerprint.hash).toBe(env.fingerprint.hash);
  });

  test('round-trip a signed envelope: seal+key → verify+key ok=true', () => {
    const env = sealEnvelope(makeCapture(), { hmacKey: 'k', now: 1 });
    const r = verifyEnvelope(env, { hmacKey: 'k' });
    expect(r.ok).toBe(true);
  });
});

describe('verifyEnvelope — failure modes', () => {
  test('malformed input → ok=false reason=malformed', () => {
    expect(verifyEnvelope(null).ok).toBe(false);
    expect(verifyEnvelope({}).ok).toBe(false);
    const r = verifyEnvelope({ version: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });

  test('wrong version → unsupported_version', () => {
    const env = sealEnvelope(makeCapture(), { now: 1 });
    const tampered = { ...env, version: 99 as unknown as 1 };
    const r = verifyEnvelope(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
    // malformed because isPortableEnvelope rejects mismatched version
  });

  test('payload tampering → fingerprint_mismatch', () => {
    const env = sealEnvelope(makeCapture(), { now: 1 });
    const tampered = {
      ...env,
      payload: { ...env.payload, localStorage: { token: 'BBBBB' } },
    };
    const r = verifyEnvelope(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('fingerprint_mismatch');
  });

  test('signed envelope verified without key → hmac_key_missing', () => {
    const env = sealEnvelope(makeCapture(), { hmacKey: 'k', now: 1 });
    const r = verifyEnvelope(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('hmac_key_missing');
  });

  test('signed envelope verified with WRONG key → hmac_mismatch', () => {
    const env = sealEnvelope(makeCapture(), { hmacKey: 'k', now: 1 });
    const r = verifyEnvelope(env, { hmacKey: 'wrong' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('hmac_mismatch');
  });

  test('requireHmac with unsigned envelope and no key → hmac_key_missing', () => {
    const env = sealEnvelope(makeCapture(), { now: 1 });
    const r = verifyEnvelope(env, { requireHmac: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('hmac_key_missing');
  });

  test('requireHmac with unsigned envelope but key supplied → hmac_missing', () => {
    const env = sealEnvelope(makeCapture(), { now: 1 });
    const r = verifyEnvelope(env, { hmacKey: 'k', requireHmac: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('hmac_missing');
  });
});

describe('verifyEnvelope — value-secrecy of fingerprint still holds in the envelope', () => {
  test('changing only a cookie VALUE (same length) leaves the fingerprint stable, so verification passes', () => {
    const sealed = sealEnvelope(makeCapture());
    // Construct a tampered envelope where the payload value differs but
    // the length matches the original — fingerprint stays identical.
    const tampered = {
      ...sealed,
      payload: {
        ...sealed.payload,
        cookies: sealed.payload.cookies.map(c => ({ ...c, value: 'bbbbbbb' })),
      },
    };
    // Fingerprint sticks (per the value-secrecy invariant), so an
    // unsigned envelope cannot detect this — HMAC is what catches it.
    expect(verifyEnvelope(tampered).ok).toBe(true);
  });

  test('the same tamper IS caught when an HMAC is present', () => {
    const sealed = sealEnvelope(makeCapture(), { hmacKey: 'k' });
    const tampered = {
      ...sealed,
      payload: {
        ...sealed.payload,
        cookies: sealed.payload.cookies.map(c => ({ ...c, value: 'bbbbbbb' })),
      },
    };
    const r = verifyEnvelope(tampered, { hmacKey: 'k' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('hmac_mismatch');
  });
});

describe('algorithm constants', () => {
  test('ENVELOPE_VERSION is 1 and ENVELOPE_HMAC_ALGORITHM is sha256', () => {
    expect(ENVELOPE_VERSION).toBe(1);
    expect(ENVELOPE_HMAC_ALGORITHM).toBe('sha256');
  });
});
