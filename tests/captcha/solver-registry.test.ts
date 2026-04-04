/**
 * CAPTCHA Solver Registry Tests (#574)
 */
import { SolverRegistry } from '../../src/captcha/solver-registry';

describe('SolverRegistry', () => {
  let registry: SolverRegistry;

  beforeEach(() => {
    // Clear env vars
    delete process.env.OPENCHROME_CAPTCHA_PROVIDER;
    delete process.env.OPENCHROME_CAPTCHA_API_KEY;
    delete process.env.OPENCHROME_CAPTCHA_AUTO_SOLVE;
    delete process.env.OPENCHROME_CAPTCHA_DAILY_LIMIT;
    registry = new SolverRegistry();
  });

  it('should not be configured without env vars', () => {
    expect(registry.isConfigured()).toBe(false);
    expect(registry.isAutoSolveEnabled()).toBe(false);
    expect(registry.getProviderName()).toBeNull();
  });

  it('should not be able to solve without configuration', () => {
    expect(registry.canSolve('turnstile')).toBe(false);
  });

  it('should throw on solve without configuration', async () => {
    await expect(registry.solve({
      captchaType: 'turnstile',
      siteKey: 'test',
      pageUrl: 'http://test.com',
    })).rejects.toThrow('No CAPTCHA solver configured');
  });

  it('should initialize cost tracker at zero', () => {
    const tracker = registry.getCostTracker();
    expect(tracker.totalSolves).toBe(0);
    expect(tracker.totalCostUsd).toBe(0);
    expect(tracker.dailySolves).toBe(0);
    expect(tracker.dailyLimitReached).toBe(false);
  });

  it('should respect daily limit from env var', () => {
    process.env.OPENCHROME_CAPTCHA_DAILY_LIMIT = '50';
    const r = new SolverRegistry();
    const tracker = r.getCostTracker();
    expect(tracker.dailyLimitReached).toBe(false);
  });

  it('should detect auto-solve setting', () => {
    process.env.OPENCHROME_CAPTCHA_AUTO_SOLVE = 'true';
    const r = new SolverRegistry();
    // Not configured, so auto-solve is still false
    expect(r.isAutoSolveEnabled()).toBe(false);
  });
});
