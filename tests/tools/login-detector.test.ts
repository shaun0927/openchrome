import { classifyLoginSignals, detectLoginOutcome, InPageSignals } from '../../src/tools/login-detector';

function signals(overrides: Partial<InPageSignals> = {}): InPageSignals {
  return {
    loginFormStillMounted: false,
    ariaErrorText: null,
    currentUrl: 'https://example.com/login',
    title: 'Login',
    ...overrides,
  };
}

describe('classifyLoginSignals (#658)', () => {
  const PRE = { preSubmitOrigin: 'https://example.com', preSubmitUrl: 'https://example.com/login' };

  it('cross-origin navigation → success', () => {
    expect(classifyLoginSignals(signals({ currentUrl: 'https://app.example.com/dashboard' }), PRE).outcome).toBe('success');
  });

  it('same-origin path change with form gone → success', () => {
    expect(classifyLoginSignals(signals({
      currentUrl: 'https://example.com/dashboard',
      loginFormStillMounted: false,
    }), PRE).outcome).toBe('success');
  });

  it('form still mounted, same URL → failed (no banner)', () => {
    const r = classifyLoginSignals(signals({ loginFormStillMounted: true }), PRE);
    expect(r.outcome).toBe('failed');
    expect(r.reason).toContain('still mounted');
  });

  it('form still mounted, error banner present → failed (banner in reason)', () => {
    const r = classifyLoginSignals(signals({
      loginFormStillMounted: true,
      ariaErrorText: 'Invalid email or password',
    }), PRE);
    expect(r.outcome).toBe('failed');
    expect(r.reason).toContain('Invalid email or password');
  });

  it('form gone, same URL (SPA mid-transition) → unknown (don\'t false-positive)', () => {
    expect(classifyLoginSignals(signals({ loginFormStillMounted: false }), PRE).outcome).toBe('unknown');
  });

  it('2FA: form gone, URL unchanged briefly → unknown (NOT failed)', () => {
    expect(classifyLoginSignals(signals({
      loginFormStillMounted: false,
      currentUrl: 'https://example.com/login',
    }), PRE).outcome).toBe('unknown');
  });

  it('magic-link page: same origin, form gone, has banner → unknown', () => {
    // "Check your email" banner is typically positive UI, not a login error.
    // Detector should NOT mark as failed when form is gone.
    expect(classifyLoginSignals(signals({
      loginFormStillMounted: false,
      ariaErrorText: 'Check your email for the magic link',
    }), PRE).outcome).toBe('unknown');
  });

  it('malformed currentUrl falls back to unknown rather than throwing', () => {
    expect(classifyLoginSignals(signals({ currentUrl: 'not-a-url' }), PRE).outcome).toBe('unknown');
  });
});

describe('detectLoginOutcome', () => {
  it('returns unknown when page.evaluate throws', async () => {
    const fakePage = {
      url: () => 'https://example.com/login',
      evaluate: () => Promise.reject(new Error('detached frame')),
    };
    const result = await detectLoginOutcome(fakePage as any, {
      preSubmitOrigin: 'https://example.com',
      preSubmitUrl: 'https://example.com/login',
    });
    expect(result.outcome).toBe('unknown');
    expect(result.reason).toContain('detector error');
  });

  it('passes through structured failure signal', async () => {
    const fakePage = {
      url: () => 'https://example.com/login',
      evaluate: () =>
        Promise.resolve({
          loginFormStillMounted: true,
          ariaErrorText: 'Wrong password',
          currentUrl: 'https://example.com/login',
          title: 'Login',
        } as InPageSignals),
    };
    const result = await detectLoginOutcome(fakePage as any, {
      preSubmitOrigin: 'https://example.com',
      preSubmitUrl: 'https://example.com/login',
    });
    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('Wrong password');
  });

  it('returns unknown when page.evaluate returns null', async () => {
    const fakePage = {
      url: () => 'https://example.com/login',
      evaluate: () => Promise.resolve(null),
    };
    const result = await detectLoginOutcome(fakePage as any, {
      preSubmitOrigin: 'https://example.com',
      preSubmitUrl: 'https://example.com/login',
    });
    expect(result.outcome).toBe('unknown');
    expect(result.reason).toContain('no data');
  });
});
