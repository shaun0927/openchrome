/// <reference types="jest" />

/**
 * Unit tests for src/gates/detect-other-gates.ts (B2-PR2 of #1359).
 *
 * Each detector is fact-only: no network, no judgment. The tests pin the
 * heuristics that the broader oc_gate_inspect composer depends on.
 */

import {
  detectSsoSignalFromUrl,
  detectSso,
  detectPaywall,
  detectTwoFactor,
  detectNonCaptchaGate,
} from '../../src/gates/detect-other-gates';

function makePage(url: string, evalImpl: (fn: any, ...args: any[]) => any): any {
  return {
    url: () => url,
    evaluate: jest.fn(async (fn: any, ...args: any[]) => evalImpl(fn, ...args)),
  };
}

describe('detectSsoSignalFromUrl', () => {
  test('returns null for empty / invalid URLs', () => {
    expect(detectSsoSignalFromUrl('')).toBeNull();
    expect(detectSsoSignalFromUrl('not a url')).toBeNull();
    expect(detectSsoSignalFromUrl(null as unknown as string)).toBeNull();
  });

  test('matches Microsoft, Google, Okta, Auth0, GitHub, Apple', () => {
    expect(detectSsoSignalFromUrl('https://login.microsoftonline.com/common/oauth2/authorize')?.provider).toBe('microsoft');
    expect(detectSsoSignalFromUrl('https://accounts.google.com/o/oauth2/v2/auth')?.provider).toBe('google');
    expect(detectSsoSignalFromUrl('https://acme.okta.com/sso/saml')?.provider).toBe('okta');
    expect(detectSsoSignalFromUrl('https://acme.auth0.com/authorize')?.provider).toBe('auth0');
    expect(detectSsoSignalFromUrl('https://github.com/login/oauth/authorize')?.provider).toBe('github');
    expect(detectSsoSignalFromUrl('https://appleid.apple.com/auth/authorize')?.provider).toBe('apple');
  });

  test('generic SSO path hints surface as provider="generic"', () => {
    expect(detectSsoSignalFromUrl('https://corp.example.com/sso/login')?.provider).toBe('generic');
    expect(detectSsoSignalFromUrl('https://example.com/oauth2/authorize?client_id=x')?.provider).toBe('generic');
    expect(detectSsoSignalFromUrl('https://example.com/auth/realms/test/login-actions')?.provider).toBe('generic');
  });

  test('non-SSO URLs return null', () => {
    expect(detectSsoSignalFromUrl('https://example.com/')).toBeNull();
    expect(detectSsoSignalFromUrl('https://example.com/articles/123')).toBeNull();
  });

  test('returned signal carries kind, gateType, pageUrl', () => {
    const s = detectSsoSignalFromUrl('https://accounts.google.com/o/oauth2/v2/auth');
    expect(s?.kind).toBe('sso');
    expect(s?.gateType).toBe('sso_redirect');
    expect(s?.pageUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });
});

describe('detectSso (page)', () => {
  test('reads page.url() and runs the URL heuristic', async () => {
    const page = makePage('https://accounts.google.com/signin', () => null);
    const out = await detectSso(page);
    expect(out?.provider).toBe('google');
  });

  test('returns null when the page URL throws', async () => {
    const page = { url: () => { throw new Error('detached'); } };
    expect(await detectSso(page as any)).toBeNull();
  });
});

describe('detectPaywall', () => {
  test('returns signal when probe matches a selector', async () => {
    const page = makePage('https://news.example.com/article', () => ({ selector: '.paywall' }));
    const out = await detectPaywall(page);
    expect(out).toEqual({
      kind: 'paywall',
      gateType: 'paywall',
      selector: '.paywall',
      pageUrl: 'https://news.example.com/article',
    });
  });

  test('returns null when probe finds nothing', async () => {
    const page = makePage('https://news.example.com/article', () => null);
    expect(await detectPaywall(page)).toBeNull();
  });

  test('returns null and does not throw if evaluate throws', async () => {
    const page = {
      url: () => 'https://example.com',
      evaluate: jest.fn(async () => { throw new Error('boom'); }),
    };
    expect(await detectPaywall(page as any)).toBeNull();
  });
});

describe('detectTwoFactor', () => {
  test('returns signal when probe finds an OTP input', async () => {
    const page = makePage('https://example.com/login/verify', () => ({
      selector: 'input[autocomplete="one-time-code"]',
    }));
    const out = await detectTwoFactor(page);
    expect(out).toEqual({
      kind: '2fa',
      gateType: 'two_factor',
      selector: 'input[autocomplete="one-time-code"]',
      pageUrl: 'https://example.com/login/verify',
    });
  });

  test('returns null when probe finds nothing', async () => {
    const page = makePage('https://example.com/', () => null);
    expect(await detectTwoFactor(page)).toBeNull();
  });
});

describe('detectNonCaptchaGate — priority composer', () => {
  test('SSO wins over paywall / 2fa', async () => {
    const page = {
      url: () => 'https://accounts.google.com/signin',
      evaluate: jest.fn(),
    };
    const out = await detectNonCaptchaGate(page as any);
    expect(out?.kind).toBe('sso');
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  test('paywall wins over 2fa when there is no SSO', async () => {
    let call = 0;
    const page = {
      url: () => 'https://news.example.com/article',
      evaluate: jest.fn(async () => {
        call += 1;
        if (call === 1) return { selector: '.paywall' };
        return null;
      }),
    };
    const out = await detectNonCaptchaGate(page as any);
    expect(out?.kind).toBe('paywall');
  });

  test('2fa is the last fallback', async () => {
    let call = 0;
    const page = {
      url: () => 'https://example.com/verify',
      evaluate: jest.fn(async () => {
        call += 1;
        // 1st: paywall probe → null. 2nd: 2fa probe → match.
        if (call === 1) return null;
        return { selector: 'input[name="otp"]' };
      }),
    };
    const out = await detectNonCaptchaGate(page as any);
    expect(out?.kind).toBe('2fa');
  });

  test('returns null when nothing matches', async () => {
    const page = {
      url: () => 'https://example.com/',
      evaluate: jest.fn(async () => null),
    };
    expect(await detectNonCaptchaGate(page as any)).toBeNull();
  });
});
