/// <reference types="jest" />

import { blockingPageRules } from '../../src/hints/rules/blocking-page';
import type { HintContext } from '../../src/hints/hint-engine';

function makeCtx(overrides: Partial<HintContext>): HintContext {
  return {
    toolName: 'navigate',
    resultText: '',
    isError: false,
    recentCalls: [],
    fireCounts: new Map(),
    ...overrides,
  };
}

describe('Blocking Page Rules', () => {
  const captchaRule = blockingPageRules.find(r => r.name === 'captcha-detected')!;
  const botCheckRule = blockingPageRules.find(r => r.name === 'bot-check-detected')!;
  const accessDeniedRule = blockingPageRules.find(r => r.name === 'access-denied-detected')!;

  describe('captcha-detected', () => {
    it('should fire when blockingPage type is captcha', () => {
      const ctx = makeCtx({
        resultText: JSON.stringify({
          action: 'navigate',
          url: 'https://example.com',
          blockingPage: { type: 'captcha', detail: 'Cloudflare Turnstile' },
        }),
      });
      expect(captchaRule.match(ctx)).toContain('CAPTCHA detected');
    });

    it('should not fire on normal navigate results', () => {
      const ctx = makeCtx({
        resultText: JSON.stringify({
          action: 'navigate',
          url: 'https://example.com',
          title: 'Example',
        }),
      });
      expect(captchaRule.match(ctx)).toBeNull();
    });

    it('should not fire on error results', () => {
      const ctx = makeCtx({
        isError: true,
        resultText: JSON.stringify({
          blockingPage: { type: 'captcha' },
        }),
      });
      expect(captchaRule.match(ctx)).toBeNull();
    });

    it('should not fire on non-navigate tools', () => {
      const ctx = makeCtx({
        toolName: 'read_page',
        resultText: JSON.stringify({
          blockingPage: { type: 'captcha' },
        }),
      });
      expect(captchaRule.match(ctx)).toBeNull();
    });
  });

  describe('bot-check-detected', () => {
    it('should fire when blockingPage type is bot-check', () => {
      const ctx = makeCtx({
        resultText: JSON.stringify({
          blockingPage: { type: 'bot-check', detail: 'Verify you are human' },
        }),
      });
      expect(botCheckRule.match(ctx)).toContain('Bot verification');
    });
  });

  describe('access-denied-detected', () => {
    it('should fire when blockingPage type is access-denied', () => {
      const ctx = makeCtx({
        resultText: JSON.stringify({
          blockingPage: { type: 'access-denied', detail: '403 Forbidden' },
        }),
      });
      expect(accessDeniedRule.match(ctx)).toContain('Access denied');
    });
  });
});
