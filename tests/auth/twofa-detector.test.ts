/// <reference types="jest" />
/**
 * Unit tests for 2FA Detection Engine
 */

import { detectTwoFA, classifyTwoFAType, TwoFAType } from '../../src/auth/twofa-detector';

/** Build a minimal mock page that returns specific body text and input state */
function makeMockPage(bodyText: string, inputs: Array<Record<string, string>> = [], buttons: Array<{ innerText: string; id?: string }> = []) {
  return {
    evaluate: jest.fn().mockImplementation((fn: Function) => {
      // Simulate page.evaluate running in "page context"
      // We capture what the real evaluate would return by calling the function
      // with a fake DOM-like environment
      return Promise.resolve(
        fn.call(
          undefined,
          // The evaluate fn receives no args (it uses document directly)
          // We override it by making evaluate return a static payload instead
        ),
      );
    }),
  };
}

/** Create a mock page whose evaluate resolves to a fixed PageSignals object */
function makePage(signals: {
  pageText: string;
  inputSelector?: string;
  inputAttributes?: Record<string, string>;
  submitSelector?: string;
}) {
  return {
    evaluate: jest.fn().mockResolvedValue(signals),
    url: jest.fn().mockReturnValue('https://example.com/login/2fa'),
  };
}

describe('classifyTwoFAType', () => {
  describe('TOTP classification', () => {
    test('identifies authenticator text as TOTP', () => {
      expect(classifyTwoFAType('Enter your authenticator code')).toBe(TwoFAType.TOTP);
    });

    test('identifies "verification code" text as TOTP', () => {
      expect(classifyTwoFAType('Enter your verification code to continue')).toBe(TwoFAType.TOTP);
    });

    test('identifies "6-digit code" text as TOTP', () => {
      expect(classifyTwoFAType('Please enter the 6-digit code from your app')).toBe(TwoFAType.TOTP);
    });

    test('identifies "two-factor" text as TOTP', () => {
      expect(classifyTwoFAType('Two-factor authentication required')).toBe(TwoFAType.TOTP);
    });

    test('identifies "2FA" text as TOTP', () => {
      expect(classifyTwoFAType('2FA verification needed')).toBe(TwoFAType.TOTP);
    });

    test('authenticator text + maxlength=6 input gives TOTP', () => {
      const result = classifyTwoFAType('Enter code from your authenticator app', { maxlength: '6', type: 'text' });
      expect(result).toBe(TwoFAType.TOTP);
    });
  });

  describe('SMS classification', () => {
    test('identifies "text message" as SMS', () => {
      expect(classifyTwoFAType('We sent a text message to your number')).toBe(TwoFAType.SMS);
    });

    test('identifies "SMS" keyword as SMS type', () => {
      expect(classifyTwoFAType('Enter the SMS code we sent you')).toBe(TwoFAType.SMS);
    });

    test('identifies "sent to your phone" as SMS', () => {
      expect(classifyTwoFAType('Code sent to your phone. Please enter it.')).toBe(TwoFAType.SMS);
    });

    test('identifies masked phone pattern as SMS', () => {
      expect(classifyTwoFAType('Code sent to ***-***-1234')).toBe(TwoFAType.SMS);
    });
  });

  describe('Email classification', () => {
    test('identifies "check your email" as EMAIL', () => {
      expect(classifyTwoFAType('Please check your email for the code we sent you')).toBe(TwoFAType.EMAIL);
    });

    test('identifies "email verification" as EMAIL', () => {
      expect(classifyTwoFAType('Email verification required')).toBe(TwoFAType.EMAIL);
    });

    test('identifies "sent to your email" as EMAIL', () => {
      expect(classifyTwoFAType('Code sent to your email address')).toBe(TwoFAType.EMAIL);
    });

    test('identifies masked email pattern as EMAIL', () => {
      expect(classifyTwoFAType('Code sent to j***@gmail.com')).toBe(TwoFAType.EMAIL);
    });
  });

  describe('Push classification', () => {
    test('identifies "approve on your device" as PUSH', () => {
      expect(classifyTwoFAType('Approve on your device to continue')).toBe(TwoFAType.PUSH);
    });

    test('identifies "push notification" as PUSH', () => {
      expect(classifyTwoFAType('A push notification was sent to your app')).toBe(TwoFAType.PUSH);
    });

    test('identifies "open your app to approve" as PUSH', () => {
      expect(classifyTwoFAType('Open your app to approve this sign-in')).toBe(TwoFAType.PUSH);
    });
  });

  describe('Recovery classification', () => {
    test('identifies "backup code" as RECOVERY', () => {
      expect(classifyTwoFAType('Enter a backup code to continue')).toBe(TwoFAType.RECOVERY);
    });

    test('identifies "recovery code" as RECOVERY', () => {
      expect(classifyTwoFAType('Use a recovery code to access your account')).toBe(TwoFAType.RECOVERY);
    });
  });

  describe('Classification priority', () => {
    test('TOTP wins when both TOTP and SMS indicators present', () => {
      // Text contains both "authenticator" (TOTP) and "text message" (SMS)
      const result = classifyTwoFAType(
        'Enter the verification code from your authenticator app. ' +
        'Or enter the code from the text message we sent.',
      );
      expect(result).toBe(TwoFAType.TOTP);
    });

    test('TOTP wins over email when authenticator text present', () => {
      const result = classifyTwoFAType(
        'Enter your authenticator code. Check your email for details.',
      );
      expect(result).toBe(TwoFAType.TOTP);
    });

    test('Unknown for regular login page', () => {
      expect(classifyTwoFAType('Enter your username and password')).toBe(TwoFAType.UNKNOWN);
    });

    test('Unknown for empty text', () => {
      expect(classifyTwoFAType('')).toBe(TwoFAType.UNKNOWN);
    });
  });
});

describe('detectTwoFA', () => {
  describe('TOTP detection', () => {
    test('detects 6-digit input with authenticator text', async () => {
      const page = makePage({
        pageText: 'Enter the 6-digit code from your authenticator app',
        inputSelector: '#otp-input',
        inputAttributes: { maxlength: '6', type: 'text', name: 'otp', id: 'otp-input', pattern: '', autocomplete: 'one-time-code', placeholder: '' },
        submitSelector: 'button[type="submit"]',
      });

      const result = await detectTwoFA(page);

      expect(result.detected).toBe(true);
      expect(result.type).toBe(TwoFAType.TOTP);
      expect(result.confidence).toBeGreaterThan(0.7);
      expect(result.inputSelector).toBe('#otp-input');
      expect(result.hints).toContain('TOTP authenticator code required');
    });

    test('gives high confidence for authenticator keyword + 6-digit input', async () => {
      const page = makePage({
        pageText: 'Open your authenticator app and enter the 6-digit code',
        inputSelector: 'input[maxlength="6"]',
        inputAttributes: { maxlength: '6', type: 'text', name: '', id: '', pattern: '', autocomplete: '', placeholder: '' },
      });

      const result = await detectTwoFA(page);

      expect(result.detected).toBe(true);
      expect(result.type).toBe(TwoFAType.TOTP);
      expect(result.confidence).toBeGreaterThan(0.7);
    });
  });

  describe('SMS detection', () => {
    test('identifies SMS-related text patterns', async () => {
      const page = makePage({
        pageText: 'Enter the code sent via SMS to ***-***-5678',
        inputSelector: 'input[name="code"]',
        inputAttributes: { maxlength: '6', type: 'text', name: 'code', id: '', pattern: '', autocomplete: '', placeholder: '' },
      });

      const result = await detectTwoFA(page);

      expect(result.detected).toBe(true);
      expect(result.type).toBe(TwoFAType.SMS);
    });
  });

  describe('Email detection', () => {
    test('identifies email verification patterns', async () => {
      const page = makePage({
        pageText: 'Check your email at j***@gmail.com for the code we sent',
        inputSelector: '#email-code',
        inputAttributes: { maxlength: '6', type: 'text', name: 'code', id: 'email-code', pattern: '', autocomplete: '', placeholder: '' },
      });

      const result = await detectTwoFA(page);

      expect(result.detected).toBe(true);
      expect(result.type).toBe(TwoFAType.EMAIL);
    });
  });

  describe('Push detection', () => {
    test('identifies push notification patterns', async () => {
      const page = makePage({
        pageText: 'Approve on your device. A push notification has been sent to your app.',
      });

      const result = await detectTwoFA(page);

      expect(result.detected).toBe(true);
      expect(result.type).toBe(TwoFAType.PUSH);
    });
  });

  describe('Recovery detection', () => {
    test('identifies recovery code patterns', async () => {
      const page = makePage({
        pageText: 'Enter a backup code or recovery code from your saved list',
        inputSelector: '#recovery-input',
        inputAttributes: { maxlength: '12', type: 'text', name: 'recovery', id: 'recovery-input', pattern: '', autocomplete: '', placeholder: '' },
      });

      const result = await detectTwoFA(page);

      expect(result.detected).toBe(true);
      expect(result.type).toBe(TwoFAType.RECOVERY);
    });
  });

  describe('No 2FA', () => {
    test('returns detected=false for regular login page', async () => {
      const page = makePage({
        pageText: 'Sign in to your account. Enter your username and password.',
      });

      const result = await detectTwoFA(page);

      expect(result.detected).toBe(false);
      expect(result.type).toBe(TwoFAType.UNKNOWN);
      expect(result.confidence).toBe(0);
    });

    test('handles page.evaluate failure gracefully', async () => {
      const page = {
        evaluate: jest.fn().mockRejectedValue(new Error('Frame detached')),
        url: jest.fn().mockReturnValue('https://example.com'),
      };

      const result = await detectTwoFA(page);

      expect(result.detected).toBe(false);
      expect(result.hints).toContain('Detection failed: could not access page content');
    });
  });

  describe('Confidence scoring', () => {
    test('authenticator keyword + 6-digit input = high confidence', async () => {
      const page = makePage({
        pageText: 'Enter your authenticator code below',
        inputSelector: '#code',
        inputAttributes: { maxlength: '6', type: 'text', name: 'code', id: 'code', pattern: '', autocomplete: '', placeholder: '' },
      });

      const result = await detectTwoFA(page);

      expect(result.confidence).toBeGreaterThan(0.7);
    });

    test('low confidence for ambiguous page', async () => {
      const page = makePage({
        pageText: 'Enter your code',
        inputSelector: 'input[name="code"]',
        inputAttributes: { maxlength: '6', type: 'text', name: 'code', id: '', pattern: '', autocomplete: '', placeholder: '' },
      });

      // "Enter your code" alone triggers TOTP via "6-digit input" input attribute
      const result = await detectTwoFA(page);

      // Confidence should be lower than the high-signal case
      expect(result.confidence).toBeLessThan(0.9);
    });
  });
});
