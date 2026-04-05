/**
 * CAPTCHA Handler Tests (#574)
 */
import { BlockingInfo } from '../../src/utils/page-diagnostics';

describe('CAPTCHA Handler', () => {
  it('should export handleCaptcha function', async () => {
    const mod = await import('../../src/captcha/handler');
    expect(typeof mod.handleCaptcha).toBe('function');
  });

  it('should export checkDomainCaptchaHistory function', async () => {
    const mod = await import('../../src/captcha/handler');
    expect(typeof mod.checkDomainCaptchaHistory).toBe('function');
  });

  it('should return not-solved when no solver configured', async () => {
    // Clear env to ensure no solver
    delete process.env.OPENCHROME_CAPTCHA_PROVIDER;
    delete process.env.OPENCHROME_CAPTCHA_API_KEY;

    const { handleCaptcha } = await import('../../src/captcha/handler');
    const page = {
      evaluate: () => Promise.resolve(null),
      url: () => 'http://test.com',
    } as any;
    const blocking: BlockingInfo = {
      type: 'captcha',
      detail: 'test',
      captchaType: 'turnstile',
    };

    const result = await handleCaptcha(page, blocking);
    expect(result.solved).toBe(false);
    expect(result.error).toContain('No CAPTCHA solver configured');
  });

  it('checkDomainCaptchaHistory should return null for unknown domains', async () => {
    const { checkDomainCaptchaHistory } = await import('../../src/captcha/handler');
    expect(checkDomainCaptchaHistory('http://never-seen-before-domain.test')).toBeNull();
  });
});

describe('Solution Injector', () => {
  it('should export injectSolution function', async () => {
    const mod = await import('../../src/captcha/inject-solution');
    expect(typeof mod.injectSolution).toBe('function');
  });

  it('should handle injection errors gracefully', async () => {
    const { injectSolution } = await import('../../src/captcha/inject-solution');
    const page = {
      evaluate: () => Promise.reject(new Error('page crashed')),
    } as any;
    const result = await injectSolution(page, 'turnstile', 'token');
    expect(result).toBe(false);
  });
});

describe('Fallback chain integration', () => {
  it('navigate.ts should import handleCaptcha', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync('src/tools/navigate.ts', 'utf-8');
    expect(content).toContain('handleCaptcha');
    expect(content).toContain('getSolverRegistry');
  });

  it('navigate.ts should have captcha_solved response field', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync('src/tools/navigate.ts', 'utf-8');
    expect(content).toContain('captcha_solved');
  });
});
