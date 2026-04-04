/// <reference types="jest" />
/**
 * Unit tests for TOTP Manager (RFC 6238)
 */

import {
  generateTOTP,
  validateBase32,
  base32Decode,
  hmacDigest,
  dynamicTruncation,
} from '../../src/auth/totp-manager';

// RFC 6238 test vectors use SHA1 with the ASCII secret "12345678901234567890"
// Base32 encoding of "12345678901234567890":
// Each ASCII char is a byte; base32-encode the raw bytes.
const RFC_SECRET_ASCII = '12345678901234567890';
// Pre-computed base32 of the 20-byte ASCII sequence
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('validateBase32', () => {
  test('accepts valid uppercase base32', () => {
    expect(validateBase32('JBSWY3DPEHPK3PXP')).toBe(true);
  });

  test('accepts valid lowercase base32 (case-insensitive)', () => {
    expect(validateBase32('jbswy3dpehpk3pxp')).toBe(true);
  });

  test('accepts base32 with padding', () => {
    expect(validateBase32('JBSWY3DPEHPK3PXP==')).toBe(true);
  });

  test('accepts base32 with whitespace', () => {
    expect(validateBase32('JBSWY 3DPE HPK3 PXP')).toBe(true);
  });

  test('rejects string with invalid characters (0, 1, 8, 9)', () => {
    expect(validateBase32('INVALID0189')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(validateBase32('')).toBe(false);
  });

  test('rejects string that is only padding/whitespace', () => {
    expect(validateBase32('   ')).toBe(false);
    expect(validateBase32('===')).toBe(false);
  });

  test('accepts RFC test secret in base32', () => {
    expect(validateBase32(RFC_SECRET_BASE32)).toBe(true);
  });
});

describe('base32Decode', () => {
  test('decodes known secret correctly', () => {
    // "JBSWY3DPEHPK3PXP" decodes to the bytes: 48 65 6c 6c 6f 21 de ad be ef
    const decoded = base32Decode('JBSWY3DPEHPK3PXP');
    const expected = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef]);
    expect(decoded).toEqual(expected);
  });

  test('decodes RFC test vector base32 to ASCII bytes', () => {
    const decoded = base32Decode(RFC_SECRET_BASE32);
    const expected = Buffer.from(RFC_SECRET_ASCII, 'ascii');
    expect(decoded).toEqual(expected);
  });

  test('decodes case-insensitively', () => {
    const upper = base32Decode('JBSWY3DPEHPK3PXP');
    const lower = base32Decode('jbswy3dpehpk3pxp');
    expect(upper).toEqual(lower);
  });

  test('throws on invalid base32 character', () => {
    expect(() => base32Decode('INVALID0189')).toThrow('Invalid base32 character');
  });
});

describe('hmacDigest', () => {
  test('returns a Buffer', () => {
    const key = Buffer.from('secret');
    const counter = Buffer.alloc(8, 0);
    const result = hmacDigest('sha1', key, counter);
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  test('SHA1 HMAC produces 20-byte output', () => {
    const key = Buffer.from('key');
    const counter = Buffer.alloc(8, 1);
    const result = hmacDigest('sha1', key, counter);
    expect(result.length).toBe(20);
  });

  test('same inputs produce same output (deterministic)', () => {
    const key = Buffer.from('testkey');
    const counter = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]);
    const r1 = hmacDigest('sha1', key, counter);
    const r2 = hmacDigest('sha1', key, counter);
    expect(r1).toEqual(r2);
  });
});

describe('dynamicTruncation', () => {
  test('returns a number', () => {
    const hmac = Buffer.alloc(20, 0xab);
    const result = dynamicTruncation(hmac);
    expect(typeof result).toBe('number');
  });

  test('result fits in 31 bits (< 0x80000000)', () => {
    // Try many patterns
    for (let i = 0; i < 256; i++) {
      const hmac = Buffer.alloc(20, i);
      const result = dynamicTruncation(hmac);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(0x80000000);
    }
  });
});

describe('generateTOTP', () => {
  // Well-known secret for deterministic tests
  const KNOWN_SECRET = 'JBSWY3DPEHPK3PXP'; // "Hello!" in base32

  test('generates a 6-character string', () => {
    const code = generateTOTP(KNOWN_SECRET);
    expect(typeof code).toBe('string');
    expect(code).toHaveLength(6);
  });

  test('output is all digits', () => {
    const code = generateTOTP(KNOWN_SECRET);
    expect(/^\d{6}$/.test(code)).toBe(true);
  });

  test('respects digits option (8 digits)', () => {
    const code = generateTOTP(KNOWN_SECRET, { digits: 8 });
    expect(code).toHaveLength(8);
    expect(/^\d{8}$/.test(code)).toBe(true);
  });

  test('same time step produces same code (deterministic)', () => {
    const now = 1700000000000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const c1 = generateTOTP(KNOWN_SECRET);
    const c2 = generateTOTP(KNOWN_SECRET);
    expect(c1).toBe(c2);
    jest.restoreAllMocks();
  });

  test('code changes when time step changes', () => {
    // Step 1
    jest.spyOn(Date, 'now').mockReturnValue(0);
    const c1 = generateTOTP(KNOWN_SECRET);
    // Step 2 (30 seconds later)
    jest.spyOn(Date, 'now').mockReturnValue(30000);
    const c2 = generateTOTP(KNOWN_SECRET);
    // Step 3 (60 seconds after start)
    jest.spyOn(Date, 'now').mockReturnValue(60000);
    const c3 = generateTOTP(KNOWN_SECRET);

    // At least two of the three codes should differ (statistically certain)
    const allSame = c1 === c2 && c2 === c3;
    expect(allSame).toBe(false);
    jest.restoreAllMocks();
  });

  describe('RFC 6238 test vectors (SHA1)', () => {
    // RFC 6238 Appendix B — SHA1 test vectors
    // Secret: "12345678901234567890" (20 ASCII bytes)
    // T0=0, period=30
    const vectors: Array<{ unixTime: number; expected: string }> = [
      { unixTime: 59, expected: '287082' },
      { unixTime: 1111111109, expected: '081804' },
      { unixTime: 1111111111, expected: '050471' },
      { unixTime: 1234567890, expected: '005924' },
      { unixTime: 2000000000, expected: '279037' },
    ];

    for (const { unixTime, expected } of vectors) {
      test(`at T=${unixTime} code is ${expected}`, () => {
        jest.spyOn(Date, 'now').mockReturnValue(unixTime * 1000);
        const code = generateTOTP(RFC_SECRET_BASE32, { algorithm: 'sha1', digits: 6, period: 30 });
        expect(code).toBe(expected);
        jest.restoreAllMocks();
      });
    }
  });

  describe('clock drift / timeOffset', () => {
    test('timeOffset=0 and timeOffset=1 can produce different codes', () => {
      jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      const current = generateTOTP(KNOWN_SECRET, { timeOffset: 0 });
      const next = generateTOTP(KNOWN_SECRET, { timeOffset: 1 });
      const prev = generateTOTP(KNOWN_SECRET, { timeOffset: -1 });

      // They are each valid 6-digit codes
      expect(/^\d{6}$/.test(current)).toBe(true);
      expect(/^\d{6}$/.test(next)).toBe(true);
      expect(/^\d{6}$/.test(prev)).toBe(true);

      // At least one adjacent step differs
      expect(current === next && current === prev).toBe(false);
      jest.restoreAllMocks();
    });

    test('timeOffset shifts the time step by the given amount', () => {
      const fixedTime = 1700000000000; // T-step = floor(1700000000 / 30)
      jest.spyOn(Date, 'now').mockReturnValue(fixedTime);

      const codeAtStep = generateTOTP(KNOWN_SECRET, { timeOffset: 0 });

      // Advance clock by exactly 1 period
      jest.spyOn(Date, 'now').mockReturnValue(fixedTime + 30000);
      const codeNextStep = generateTOTP(KNOWN_SECRET, { timeOffset: 0 });

      // Rewind clock, use offset +1 to simulate "next step"
      jest.spyOn(Date, 'now').mockReturnValue(fixedTime);
      const codeWithOffset = generateTOTP(KNOWN_SECRET, { timeOffset: 1 });

      expect(codeWithOffset).toBe(codeNextStep);
      expect(codeWithOffset).not.toBe(codeAtStep);
      jest.restoreAllMocks();
    });
  });
});
