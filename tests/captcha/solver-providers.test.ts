/**
 * CAPTCHA Solver Providers Tests (#574)
 */
import { TwoCaptchaSolver } from '../../src/captcha/providers/twocaptcha';
import { AntiCaptchaSolver } from '../../src/captcha/providers/anticaptcha';
import { CapSolverSolver } from '../../src/captcha/providers/capsolver';

describe('TwoCaptchaSolver', () => {
  const solver = new TwoCaptchaSolver({ apiKey: 'test-key' });

  it('should have correct name', () => {
    expect(solver.name).toBe('2captcha');
  });

  it('should support reCAPTCHA v2/v3, hCaptcha, Turnstile', () => {
    expect(solver.supportsType('recaptcha_v2')).toBe(true);
    expect(solver.supportsType('recaptcha_v3')).toBe(true);
    expect(solver.supportsType('hcaptcha')).toBe(true);
    expect(solver.supportsType('turnstile')).toBe(true);
  });

  it('should not support AWS WAF or unknown', () => {
    expect(solver.supportsType('aws_waf')).toBe(false);
    expect(solver.supportsType('unknown')).toBe(false);
  });

  it('should have default timeout of 120s', () => {
    expect(solver.timeoutMs).toBe(120000);
  });

  it('should have default poll interval of 5s', () => {
    expect(solver.pollIntervalMs).toBe(5000);
  });
});

describe('AntiCaptchaSolver', () => {
  const solver = new AntiCaptchaSolver({ apiKey: 'test-key' });

  it('should have correct name', () => {
    expect(solver.name).toBe('anticaptcha');
  });

  it('should support reCAPTCHA v2/v3, hCaptcha, Turnstile', () => {
    expect(solver.supportsType('recaptcha_v2')).toBe(true);
    expect(solver.supportsType('recaptcha_v3')).toBe(true);
    expect(solver.supportsType('hcaptcha')).toBe(true);
    expect(solver.supportsType('turnstile')).toBe(true);
  });

  it('should not support AWS WAF', () => {
    expect(solver.supportsType('aws_waf')).toBe(false);
  });

  it('should respect custom timeout', () => {
    const s = new AntiCaptchaSolver({ apiKey: 'k', timeoutMs: 60000 });
    expect(s.timeoutMs).toBe(60000);
  });
});

describe('CapSolverSolver', () => {
  const solver = new CapSolverSolver({ apiKey: 'test-key' });

  it('should have correct name', () => {
    expect(solver.name).toBe('capsolver');
  });

  it('should support all main types including AWS WAF', () => {
    expect(solver.supportsType('recaptcha_v2')).toBe(true);
    expect(solver.supportsType('recaptcha_v3')).toBe(true);
    expect(solver.supportsType('hcaptcha')).toBe(true);
    expect(solver.supportsType('turnstile')).toBe(true);
    expect(solver.supportsType('aws_waf')).toBe(true);
  });

  it('should not support unknown type', () => {
    expect(solver.supportsType('unknown')).toBe(false);
  });

  it('should respect custom poll interval', () => {
    const s = new CapSolverSolver({ apiKey: 'k', pollIntervalMs: 3000 });
    expect(s.pollIntervalMs).toBe(3000);
  });
});
