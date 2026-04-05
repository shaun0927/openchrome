/**
 * CAPTCHA Detection Tests (#574)
 */
import { detectBlockingPage, BlockingInfo } from '../../src/utils/page-diagnostics';

function mockPage(result: BlockingInfo | null) {
  return { evaluate: () => Promise.resolve(result) } as any;
}

describe('BlockingInfo interface', () => {
  it('should include captchaType and captchaSiteKey as optional fields', () => {
    const info: BlockingInfo = {
      type: 'captcha', detail: 'test',
      captchaType: 'recaptcha_v2', captchaSiteKey: 'test-key',
    };
    expect(info.captchaType).toBe('recaptcha_v2');
    expect(info.captchaSiteKey).toBe('test-key');
  });

  it('should allow BlockingInfo without captcha fields', () => {
    const info: BlockingInfo = { type: 'bot-check', detail: 'test' };
    expect(info.captchaType).toBeUndefined();
  });

  it('should accept all valid captchaType values', () => {
    const types: BlockingInfo['captchaType'][] = [
      'recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'turnstile', 'aws_waf', 'unknown',
    ];
    for (const t of types) {
      const info: BlockingInfo = { type: 'captcha', detail: 'test', captchaType: t };
      expect(info.captchaType).toBe(t);
    }
  });
});

describe('detectBlockingPage()', () => {
  it('should return null for normal pages', async () => {
    expect(await detectBlockingPage(mockPage(null))).toBeNull();
  });

  it('should detect reCAPTCHA v2', async () => {
    const r = await detectBlockingPage(mockPage({
      type: 'captcha', detail: 'Login',
      captchaType: 'recaptcha_v2', captchaSiteKey: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
    }));
    expect(r!.type).toBe('captcha');
    expect(r!.captchaType).toBe('recaptcha_v2');
    expect(r!.captchaSiteKey).toBe('6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI');
  });

  it('should detect reCAPTCHA v3', async () => {
    const r = await detectBlockingPage(mockPage({
      type: 'captcha', detail: 'Login', captchaType: 'recaptcha_v3', captchaSiteKey: 'key-v3',
    }));
    expect(r!.captchaType).toBe('recaptcha_v3');
  });

  it('should detect hCaptcha', async () => {
    const r = await detectBlockingPage(mockPage({
      type: 'captcha', detail: 'Verify',
      captchaType: 'hcaptcha', captchaSiteKey: '10000000-ffff-ffff-ffff-000000000001',
    }));
    expect(r!.captchaType).toBe('hcaptcha');
    expect(r!.captchaSiteKey).toBe('10000000-ffff-ffff-ffff-000000000001');
  });

  it('should detect Cloudflare Turnstile', async () => {
    const r = await detectBlockingPage(mockPage({
      type: 'captcha', detail: 'CF', captchaType: 'turnstile', captchaSiteKey: '0x4AAA',
    }));
    expect(r!.captchaType).toBe('turnstile');
  });

  it('should detect AWS WAF', async () => {
    const r = await detectBlockingPage(mockPage({
      type: 'captcha', detail: 'AWS', captchaType: 'aws_waf',
    }));
    expect(r!.captchaType).toBe('aws_waf');
    expect(r!.captchaSiteKey).toBeUndefined();
  });

  it('should detect unknown CAPTCHA', async () => {
    const r = await detectBlockingPage(mockPage({
      type: 'captcha', detail: 'Custom', captchaType: 'unknown',
    }));
    expect(r!.captchaType).toBe('unknown');
  });

  it('should handle evaluate errors', async () => {
    const page = { evaluate: () => Promise.reject(new Error('crash')) } as any;
    expect(await detectBlockingPage(page)).toBeNull();
  });

  it('should detect bot-check without captcha fields', async () => {
    const r = await detectBlockingPage(mockPage({ type: 'bot-check', detail: 'Check' }));
    expect(r!.type).toBe('bot-check');
    expect(r!.captchaType).toBeUndefined();
  });
});

describe('captcha/detect module', () => {
  it('should export detectCaptcha', async () => {
    const mod = await import('../../src/captcha/detect');
    expect(typeof mod.detectCaptcha).toBe('function');
  });

  it('should return null for errors', async () => {
    const { detectCaptcha } = await import('../../src/captcha/detect');
    const page = { evaluate: () => Promise.reject(new Error('x')), url: () => 'http://t.com' } as any;
    expect(await detectCaptcha(page)).toBeNull();
  });

  it('should return null when no captcha', async () => {
    const { detectCaptcha } = await import('../../src/captcha/detect');
    const page = { evaluate: () => Promise.resolve(null), url: () => 'http://t.com' } as any;
    expect(await detectCaptcha(page)).toBeNull();
  });

  it('should return detection result', async () => {
    const { detectCaptcha } = await import('../../src/captcha/detect');
    const page = {
      evaluate: () => Promise.resolve({
        captchaType: 'turnstile', siteKey: { key: 'k', source: 'attribute' }, invisible: false,
      }),
      url: () => 'http://t.com/login',
    } as any;
    const r = await detectCaptcha(page);
    expect(r!.detected).toBe(true);
    expect(r!.captchaType).toBe('turnstile');
    expect(r!.pageUrl).toBe('http://t.com/login');
  });
});
