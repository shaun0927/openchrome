/// <reference types="jest" />
/**
 * Unit tests for 2FA Handler
 */

import { handleTwoFA, TwoFAHandlerOptions } from '../../src/auth/twofa-handler';
import { TwoFAType, TwoFADetectionResult } from '../../src/auth/twofa-detector';

function makeDetection(overrides: Partial<TwoFADetectionResult> = {}): TwoFADetectionResult {
  return {
    detected: true,
    type: TwoFAType.TOTP,
    confidence: 0.9,
    inputSelector: '#otp-code',
    submitSelector: 'button[type="submit"]',
    hints: ['TOTP authenticator code required'],
    ...overrides,
  };
}

function makePage(overrides: {
  url?: string;
  urlSequence?: string[];
  evaluateResult?: string;
} = {}) {
  let callCount = 0;
  const urlSequence = overrides.urlSequence || ['https://example.com/2fa'];

  return {
    url: jest.fn().mockImplementation(() => {
      const idx = Math.min(callCount, urlSequence.length - 1);
      return urlSequence[idx];
    }),
    click: jest.fn().mockResolvedValue(undefined),
    type: jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve();
    }),
    evaluate: jest.fn().mockResolvedValue(overrides.evaluateResult || ''),
    keyboard: {
      press: jest.fn().mockResolvedValue(undefined),
    },
  };
}

describe('handleTwoFA', () => {
  describe('not-detected', () => {
    test('returns not-detected when detection.detected=false', async () => {
      const detection = makeDetection({ detected: false, type: TwoFAType.UNKNOWN });
      const page = makePage();
      const options: TwoFAHandlerOptions = { domain: 'example.com' };

      const result = await handleTwoFA(page, detection, options);

      expect(result.handled).toBe(false);
      expect(result.method).toBe('not-detected');
    });
  });

  describe('TOTP handling', () => {
    test('returns manual-hint when no credential provider configured', async () => {
      const detection = makeDetection({ type: TwoFAType.TOTP });
      const page = makePage();
      const options: TwoFAHandlerOptions = { domain: 'github.com' };

      const result = await handleTwoFA(page, detection, options);

      expect(result.handled).toBe(false);
      expect(result.type).toBe(TwoFAType.TOTP);
      expect(result.method).toBe('manual-hint');
      expect(result.message).toContain('github.com');
      expect(result.message).toContain('npx openchrome totp add');
    });

    test('returns manual-hint when credential provider has no secret', async () => {
      const detection = makeDetection({ type: TwoFAType.TOTP });
      const page = makePage();
      const credentialProvider = {
        getTOTPSecret: jest.fn().mockResolvedValue(undefined),
      };
      const options: TwoFAHandlerOptions = { domain: 'github.com', credentialProvider };

      const result = await handleTwoFA(page, detection, options);

      expect(result.handled).toBe(false);
      expect(result.method).toBe('manual-hint');
      expect(result.message).toContain('github.com');
    });

    test('auto-fills when credential provider returns a secret and page changes URL', async () => {
      const detection = makeDetection({ type: TwoFAType.TOTP });
      // URL changes after first type() call, simulating successful login
      const page = makePage({
        urlSequence: ['https://github.com/login/two-factor', 'https://github.com/dashboard'],
      });
      const credentialProvider = {
        getTOTPSecret: jest.fn().mockResolvedValue('JBSWY3DPEHPK3PXP'),
      };
      const options: TwoFAHandlerOptions = {
        domain: 'github.com',
        credentialProvider,
        timeoutMs: 5000,
      };

      const result = await handleTwoFA(page, detection, options);

      expect(result.handled).toBe(true);
      expect(result.type).toBe(TwoFAType.TOTP);
      expect(result.method).toBe('auto-fill');
      expect(page.click).toHaveBeenCalledWith('#otp-code');
      expect(page.type).toHaveBeenCalledWith('#otp-code', expect.stringMatching(/^\d{6}$/));
    });

    test('retries with clock drift offset on first failure', async () => {
      const detection = makeDetection({ type: TwoFAType.TOTP });
      // URL never changes (all attempts fail)
      const page = makePage({
        urlSequence: ['https://github.com/login/two-factor'],
      });
      const credentialProvider = {
        getTOTPSecret: jest.fn().mockResolvedValue('JBSWY3DPEHPK3PXP'),
      };
      const options: TwoFAHandlerOptions = {
        domain: 'github.com',
        credentialProvider,
        maxRetries: 3,
        timeoutMs: 1000,
      };

      const result = await handleTwoFA(page, detection, options);

      // Should have tried maxRetries times
      expect(page.type).toHaveBeenCalledTimes(3);
      expect(result.handled).toBe(false);
      expect(result.method).toBe('manual-hint');
    });

    test('stops after maxRetries', async () => {
      const detection = makeDetection({ type: TwoFAType.TOTP });
      const page = makePage({
        urlSequence: ['https://github.com/login/two-factor'],
      });
      const credentialProvider = {
        getTOTPSecret: jest.fn().mockResolvedValue('JBSWY3DPEHPK3PXP'),
      };
      const options: TwoFAHandlerOptions = {
        domain: 'github.com',
        credentialProvider,
        maxRetries: 2,
        timeoutMs: 500,
      };

      await handleTwoFA(page, detection, options);

      expect(page.type).toHaveBeenCalledTimes(2);
    });
  });

  describe('SMS handling', () => {
    test('returns manual-hint with phone info', async () => {
      const detection = makeDetection({ type: TwoFAType.SMS, inputSelector: '#sms-code' });
      const page = makePage({ evaluateResult: 'Code sent to ***-***-5678' });
      const options: TwoFAHandlerOptions = { domain: 'example.com' };

      const result = await handleTwoFA(page, detection, options);

      expect(result.handled).toBe(false);
      expect(result.type).toBe(TwoFAType.SMS);
      expect(result.method).toBe('manual-hint');
      expect(result.message).toContain('SMS 2FA detected');
    });

    test('SMS includes masked phone number in message when present', async () => {
      const detection = makeDetection({ type: TwoFAType.SMS });
      const page = makePage({ evaluateResult: 'Code sent to ***-***-9012' });
      const options: TwoFAHandlerOptions = { domain: 'example.com' };

      const result = await handleTwoFA(page, detection, options);

      expect(result.message).toContain('***-***-9012');
    });
  });

  describe('Email handling', () => {
    test('returns manual-hint for email 2FA', async () => {
      const detection = makeDetection({ type: TwoFAType.EMAIL });
      const page = makePage();
      const options: TwoFAHandlerOptions = { domain: 'example.com' };

      const result = await handleTwoFA(page, detection, options);

      expect(result.handled).toBe(false);
      expect(result.type).toBe(TwoFAType.EMAIL);
      expect(result.method).toBe('manual-hint');
      expect(result.message).toContain('email');
    });
  });

  describe('Push handling', () => {
    test('returns timeout when page does not change within timeoutMs', async () => {
      const detection = makeDetection({ type: TwoFAType.PUSH, inputSelector: undefined });
      const page = makePage({
        urlSequence: ['https://example.com/2fa'],
      });
      const options: TwoFAHandlerOptions = { domain: 'example.com', timeoutMs: 600 };

      const result = await handleTwoFA(page, detection, options);

      expect(result.handled).toBe(false);
      expect(result.type).toBe(TwoFAType.PUSH);
      expect(result.method).toBe('timeout');
      expect(result.message).toContain('timed out');
    }, 5000);

    test('returns handled when page URL changes (push approved)', async () => {
      const detection = makeDetection({ type: TwoFAType.PUSH, inputSelector: undefined });
      let urlCallCount = 0;
      const page = {
        url: jest.fn().mockImplementation(() => {
          urlCallCount++;
          // First 2 calls: same URL; 3rd call: changed (approved)
          return urlCallCount <= 2
            ? 'https://example.com/2fa'
            : 'https://example.com/dashboard';
        }),
        evaluate: jest.fn().mockResolvedValue(''),
        click: jest.fn().mockResolvedValue(undefined),
        type: jest.fn().mockResolvedValue(undefined),
        keyboard: { press: jest.fn().mockResolvedValue(undefined) },
      };
      const options: TwoFAHandlerOptions = { domain: 'example.com', timeoutMs: 5000 };

      const result = await handleTwoFA(page, detection, options);

      expect(result.handled).toBe(true);
      expect(result.method).toBe('auto-fill');
    }, 10000);
  });

  describe('Recovery handling', () => {
    test('returns manual-hint for recovery codes', async () => {
      const detection = makeDetection({ type: TwoFAType.RECOVERY });
      const page = makePage();
      const options: TwoFAHandlerOptions = { domain: 'example.com' };

      const result = await handleTwoFA(page, detection, options);

      expect(result.handled).toBe(false);
      expect(result.type).toBe(TwoFAType.RECOVERY);
      expect(result.method).toBe('manual-hint');
      expect(result.message).toContain('Recovery code required');
    });
  });
});
