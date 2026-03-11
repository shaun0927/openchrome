/// <reference types="jest" />
/**
 * Unit tests for cookie classification logic (Strategy 5).
 *
 * The `classifyCookie` and `formatCookiesCompact` functions in
 * src/tools/cookies.ts are not exported, so we recreate the exact
 * algorithm here and test it in isolation. The implementation mirrors
 * lines 10-61 of cookies.ts.
 */

// ---- Types (mirrors cookies.ts) ----

type CookieTier = 'auth' | 'functional' | 'tracking';

// ---- Patterns (mirrors src/tools/cookies.ts:12-14) ----

const AUTH_PATTERNS = /^(session|token|jwt|csrf|auth|sid|ssid|connect\.sid|__Host-|__Secure-|XSRF|_csrf)/i;
const TRACKING_PATTERNS = /^(_ga|_gid|_gat|_fbp|_fbc|__utm|NID|IDE|DSID|APISID|SAPISID|HSID|__gads|_gcl|_pin|_tt_|hubspot|_hj|_clck|_clsk|mp_|ajs_|amplitude|optimizely)/i;
const TRACKING_EXACT = new Set(['fr', 'tr']); // Facebook/Twitter pixel cookies — exact name only

// ---- Algorithm (mirrors src/tools/cookies.ts:16-61) ----

function classifyCookie(name: string): CookieTier {
  if (AUTH_PATTERNS.test(name)) return 'auth';
  if (TRACKING_PATTERNS.test(name) || TRACKING_EXACT.has(name.toLowerCase())) return 'tracking';
  return 'functional';
}

function formatCookiesCompact(cookies: Array<{ name: string; value?: string; domain?: string; [key: string]: unknown }>): string {
  const auth: typeof cookies = [];
  const functional: { name: string; value: unknown; domain: unknown }[] = [];
  const tracking: { name: string; domain: string }[] = [];

  for (const cookie of cookies) {
    const tier = classifyCookie(cookie.name);
    if (tier === 'auth') {
      auth.push(cookie);
    } else if (tier === 'functional') {
      functional.push({ name: cookie.name, value: cookie.value, domain: cookie.domain });
    } else {
      tracking.push({ name: cookie.name, domain: cookie.domain ?? '' });
    }
  }

  const sections: string[] = [];

  if (auth.length > 0) {
    sections.push(`Auth cookies (${auth.length}):\n${JSON.stringify(auth, null, 2)}`);
  }

  if (functional.length > 0) {
    sections.push(`Functional cookies (${functional.length}):\n${JSON.stringify(functional, null, 2)}`);
  }

  if (tracking.length > 0) {
    const domainCounts = new Map<string, number>();
    for (const t of tracking) {
      domainCounts.set(t.domain, (domainCounts.get(t.domain) || 0) + 1);
    }
    const domainSummary = Array.from(domainCounts.entries())
      .map(([domain, count]) => `${domain}: ${count}`)
      .join(', ');
    sections.push(`Tracking cookies: ${tracking.length} total (${domainSummary})`);
  }

  return sections.join('\n\n');
}

// ---- classifyCookie tests ----

describe('classifyCookie', () => {
  describe('auth cookies', () => {
    test.each([
      ['session_token', 'auth'],
      ['csrf_token', 'auth'],
      ['jwt_abc', 'auth'],
      ['connect.sid', 'auth'],
      ['__Host-token', 'auth'],
      ['XSRF-TOKEN', 'auth'],
      ['auth_user', 'auth'],
      ['sid', 'auth'],
      ['ssid', 'auth'],
      ['__Secure-session', 'auth'],
      ['_csrf', 'auth'],
    ] as [string, CookieTier][])('%s → %s', (name, expected) => {
      expect(classifyCookie(name)).toBe(expected);
    });
  });

  describe('tracking cookies', () => {
    test.each([
      ['_ga', 'tracking'],
      ['_gid', 'tracking'],
      ['_fbp', 'tracking'],
      ['NID', 'tracking'],
      ['__utm_source', 'tracking'],
      ['_gcl_au', 'tracking'],
      ['_hj_id', 'tracking'],
      ['_gat_UA-123', 'tracking'],
      ['_fbc', 'tracking'],
      ['IDE', 'tracking'],
      ['DSID', 'tracking'],
      ['APISID', 'tracking'],
      ['SAPISID', 'tracking'],
      ['HSID', 'tracking'],
      ['__gads', 'tracking'],
      ['_pin_unauth', 'tracking'],
      ['_tt_enable', 'tracking'],
      ['hubspot_session', 'tracking'],
      ['_clck', 'tracking'],
      ['_clsk', 'tracking'],
      ['mp_mixpanel', 'tracking'],
      ['ajs_user_id', 'tracking'],
      ['amplitude_id', 'tracking'],
      ['optimizely_data', 'tracking'],
    ] as [string, CookieTier][])('%s → %s', (name, expected) => {
      expect(classifyCookie(name)).toBe(expected);
    });
  });

  describe('tracking exact-match cookies (case-insensitive)', () => {
    test('fr → tracking', () => {
      expect(classifyCookie('fr')).toBe('tracking');
    });

    test('tr → tracking', () => {
      expect(classifyCookie('tr')).toBe('tracking');
    });

    test('FR (uppercase) → tracking', () => {
      expect(classifyCookie('FR')).toBe('tracking');
    });

    test('TR (uppercase) → tracking', () => {
      expect(classifyCookie('TR')).toBe('tracking');
    });
  });

  describe('functional cookies (default tier)', () => {
    test.each([
      'theme',
      'lang',
      'consent',
      'prefs',
      'locale',
      'timezone',
      'darkmode',
      'user_preferences',
    ])('%s → functional', (name) => {
      expect(classifyCookie(name)).toBe('functional');
    });
  });

  describe('auth takes priority over tracking', () => {
    test('name starting with "session" → auth (auth checked before tracking)', () => {
      // "session" matches auth pattern; auth is checked first
      expect(classifyCookie('session')).toBe('auth');
    });

    test('name starting with "token" → auth', () => {
      expect(classifyCookie('token_ga')).toBe('auth');
    });
  });

  describe('case insensitivity', () => {
    test('SESSION_TOKEN → auth', () => {
      expect(classifyCookie('SESSION_TOKEN')).toBe('auth');
    });

    test('_GA → tracking', () => {
      expect(classifyCookie('_GA')).toBe('tracking');
    });

    test('JWT_KEY → auth', () => {
      expect(classifyCookie('JWT_KEY')).toBe('auth');
    });

    test('CSRF_TOKEN → auth', () => {
      expect(classifyCookie('CSRF_TOKEN')).toBe('auth');
    });
  });
});

// ---- formatCookiesCompact tests ----

describe('formatCookiesCompact', () => {
  test('empty input returns empty string', () => {
    expect(formatCookiesCompact([])).toBe('');
  });

  test('groups by tier: Auth, Functional, Tracking sections', () => {
    const cookies = [
      { name: 'session_id', value: 'abc', domain: 'example.com' },
      { name: 'theme', value: 'dark', domain: 'example.com' },
      { name: '_ga', value: '1.2.3', domain: '.google.com' },
    ];
    const result = formatCookiesCompact(cookies);
    expect(result).toContain('Auth cookies (1)');
    expect(result).toContain('Functional cookies (1)');
    expect(result).toContain('Tracking cookies: 1 total');
  });

  test('auth cookies include full attributes in JSON', () => {
    const cookies = [
      {
        name: 'session_id',
        value: 'secret',
        domain: 'example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ];
    const result = formatCookiesCompact(cookies);
    expect(result).toContain('Auth cookies (1)');
    // Full attributes are JSON-serialized
    expect(result).toContain('"secure"');
    expect(result).toContain('"httpOnly"');
    expect(result).toContain('"sameSite"');
  });

  test('functional cookies show only name, value, and domain', () => {
    const cookies = [
      {
        name: 'theme',
        value: 'dark',
        domain: 'example.com',
        secure: true,
        httpOnly: false,
      },
    ];
    const result = formatCookiesCompact(cookies);
    expect(result).toContain('Functional cookies (1)');
    // Secure/httpOnly attributes must NOT appear for functional cookies
    const functionalSection = result.split('\n\n').find(s => s.startsWith('Functional'));
    expect(functionalSection).toBeDefined();
    expect(functionalSection).not.toContain('"secure"');
    expect(functionalSection).not.toContain('"httpOnly"');
    // Name, value, domain must be present
    expect(functionalSection).toContain('"theme"');
    expect(functionalSection).toContain('"dark"');
    expect(functionalSection).toContain('"example.com"');
  });

  test('tracking cookies show summary format: "Tracking cookies: N total (domain: count)"', () => {
    const cookies = [
      { name: '_ga', value: '1', domain: '.google.com' },
      { name: '_gid', value: '2', domain: '.google.com' },
      { name: '_fbp', value: '3', domain: '.facebook.com' },
    ];
    const result = formatCookiesCompact(cookies);
    expect(result).toContain('Tracking cookies: 3 total');
    expect(result).toContain('.google.com: 2');
    expect(result).toContain('.facebook.com: 1');
  });

  test('all-tracking input produces only tracking section, no Auth or Functional headers', () => {
    const cookies = [
      { name: '_ga', value: '1', domain: '.google.com' },
      { name: '_gid', value: '2', domain: '.google.com' },
    ];
    const result = formatCookiesCompact(cookies);
    expect(result).toContain('Tracking cookies');
    expect(result).not.toContain('Auth cookies');
    expect(result).not.toContain('Functional cookies');
  });

  test('multiple auth cookies are counted correctly', () => {
    const cookies = [
      { name: 'session', value: 'a', domain: 'example.com' },
      { name: 'csrf_token', value: 'b', domain: 'example.com' },
      { name: 'jwt_access', value: 'c', domain: 'example.com' },
    ];
    const result = formatCookiesCompact(cookies);
    expect(result).toContain('Auth cookies (3)');
    expect(result).not.toContain('Functional');
    expect(result).not.toContain('Tracking');
  });

  test('multiple domains in tracking section are each listed separately', () => {
    const cookies = [
      { name: '_ga', value: '1', domain: '.google.com' },
      { name: '_fbp', value: '2', domain: '.facebook.com' },
      { name: 'NID', value: '3', domain: '.google.com' },
      { name: 'IDE', value: '4', domain: '.doubleclick.net' },
    ];
    const result = formatCookiesCompact(cookies);
    expect(result).toContain('Tracking cookies: 4 total');
    expect(result).toContain('.google.com: 2');
    expect(result).toContain('.facebook.com: 1');
    expect(result).toContain('.doubleclick.net: 1');
  });
});
