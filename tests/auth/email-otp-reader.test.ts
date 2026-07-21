import { extractOtp, pickNewestOtp } from '../../src/auth/email-otp-reader';

describe('email OTP reader (P17)', () => {
  describe('extractOtp — tier 1 marker patterns', () => {
    test.each([
      ['Your code is 123456.', '123456'],
      ['Your verification code is 928374 - expires in 5m', '928374'],
      ['OTP: 4321', '4321'],
      ['code - 987654', '987654'],
      ['Verification Code: 12345', '12345'],
    ])('EN marker: %s → %s', (text, expected) => {
      const m = extractOtp(text);
      expect(m?.code).toBe(expected);
      expect(m?.tier).toBe('marker');
      expect(m?.confidence).toBe(1.0);
    });

    test.each([
      ['인증 번호는 246810 입니다', '246810'],
      ['확인 코드: 135790', '135790'],
      ['일회용 비밀번호 - 555444', '555444'],
    ])('KR marker: %s → %s', (text, expected) => {
      const m = extractOtp(text);
      expect(m?.code).toBe(expected);
      expect(m?.tier).toBe('marker');
    });
  });

  describe('extractOtp — tier 2 subject line', () => {
    test('short subject with isolated code', () => {
      const m = extractOtp('321654\n\nThe rest of the email body goes on and mentions the year 2026 several times.');
      expect(m?.code).toBe('321654');
      expect(m?.tier).toBe('subject');
    });
    test('long first line disqualifies subject tier', () => {
      const text = 'This is a very long subject line that is definitely more than eighty characters long and 111222 sits in it';
      const m = extractOtp(text);
      expect(m?.tier).not.toBe('subject');
    });
  });

  describe('extractOtp — tier 3 body scan', () => {
    test('finds isolated code in body', () => {
      const text = 'Hello,\nPlease use 314159 to sign in.\nRegards.';
      const m = extractOtp(text);
      expect(m?.code).toBe('314159');
    });
    test('rejects codes adjacent to currency', () => {
      const text = 'Body\nInvoice total: $998877.\nSee attached PDF for details.';
      const m = extractOtp(text);
      expect(m?.code).not.toBe('998877');
    });
    test('rejects codes adjacent to date-like patterns', () => {
      const text = 'Body\nMeeting on 2026-05-28 at HQ.\n';
      const m = extractOtp(text);
      // Bare "2026" is 4 digits but surrounded by date pattern — rejected.
      expect(m).toBeNull();
    });
    test('rejects phone-number-like triples', () => {
      const text = 'Body\nCall us at 010 1234 5678 anytime.';
      const m = extractOtp(text);
      expect(m).toBeNull();
    });
  });

  describe('extractOtp — options', () => {
    test('respects lengthRange', () => {
      const text = 'Something 12 34567890 something';
      const m = extractOtp(text, { lengthRange: [6, 6] });
      // 12 too short, 34567890 too long, nothing matches marker/subject.
      expect(m).toBeNull();
    });
    test('extraMarkers picks vendor-specific pattern', () => {
      const text = 'Nifty security phrase 909090 stamp';
      const m = extractOtp(text, { extraMarkers: [/(?:phrase\s+)(\d{4,8})/] });
      expect(m?.code).toBe('909090');
      expect(m?.tier).toBe('marker');
    });
    test('standaloneOnly:false accepts embedded digits', () => {
      const text = 'ref_id 9998887 ends here';
      const strict = extractOtp(text);
      const loose = extractOtp(text, { standaloneOnly: false });
      expect(strict?.code).toBe('9998887');
      expect(loose?.code).toBe('9998887');
    });
    test('invalid lengthRange throws', () => {
      expect(() => extractOtp('x', { lengthRange: [2, 6] })).toThrow(RangeError);
      expect(() => extractOtp('x', { lengthRange: [6, 20] })).toThrow(RangeError);
      expect(() => extractOtp('x', { lengthRange: [8, 4] })).toThrow(RangeError);
    });
    test('empty text → null', () => {
      expect(extractOtp('')).toBeNull();
    });
  });

  describe('pickNewestOtp', () => {
    test('picks the newest message with a valid code', () => {
      const messages = [
        { text: 'old code is 111111', receivedAt: new Date('2024-01-01') },
        { text: 'Your code is 222222', receivedAt: new Date('2026-06-01') },
        { text: 'unrelated', receivedAt: new Date('2026-07-01') },
      ];
      const r = pickNewestOtp(messages);
      // Sorted newest first — but newest has no code, so falls to 2026-06-01.
      expect(r?.match.code).toBe('222222');
    });
    test('returns null when no message has a code', () => {
      const messages = [
        { text: 'hi', receivedAt: 1 },
        { text: 'bye', receivedAt: 2 },
      ];
      expect(pickNewestOtp(messages)).toBeNull();
    });
    test('missing receivedAt is treated as oldest', () => {
      const messages = [
        { text: 'no timestamp with code 313131' },
        { text: 'Your code is 424242', receivedAt: new Date('2026-06-01') },
      ];
      const r = pickNewestOtp(messages);
      expect(r?.match.code).toBe('424242');
    });
  });
});
