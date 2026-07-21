/**
 * Cloudflare challenge cookie (cf_clearance) scheme tests.
 */

import {
  ChallengeCookieStore,
  classifyCookieName,
  deriveRegistrableDomain,
  extractChallengeCookies,
  toChallengeCookie,
  type ChallengeCookie,
  type RawCookie,
} from '../../src/captcha/cf-clearance';

function mkCookie(over: Partial<ChallengeCookie> = {}): ChallengeCookie {
  return {
    kind: 'cf_clearance',
    name: 'cf_clearance',
    value: 'tokenXYZ',
    domain: 'example.com',
    secure: true,
    httpOnly: true,
    capturedAt: new Date().toISOString(),
    ...over,
  };
}

describe('classifyCookieName', () => {
  it('recognises the four named cookies', () => {
    expect(classifyCookieName('cf_clearance')).toBe('cf_clearance');
    expect(classifyCookieName('__cf_bm')).toBe('__cf_bm');
    expect(classifyCookieName('_cfuvid')).toBe('_cfuvid');
    expect(classifyCookieName('cf_chl_2_abc')).toBe('cf_chl');
  });

  it('bucket-classifies unknown cf_ / __cf cookies as other-cf', () => {
    expect(classifyCookieName('cf_something')).toBe('other-cf');
    expect(classifyCookieName('__cf_extra')).toBe('other-cf');
  });

  it('returns null for non-challenge cookies', () => {
    expect(classifyCookieName('sessionid')).toBeNull();
    expect(classifyCookieName('user_id')).toBeNull();
  });
});

describe('deriveRegistrableDomain', () => {
  it('collapses www / subdomains to eTLD+1', () => {
    expect(deriveRegistrableDomain('www.example.com')).toBe('example.com');
    expect(deriveRegistrableDomain('docs.foo.com')).toBe('foo.com');
    expect(deriveRegistrableDomain('.example.com')).toBe('example.com');
  });

  it('handles two-label ccTLDs', () => {
    expect(deriveRegistrableDomain('www.foo.co.uk')).toBe('foo.co.uk');
    expect(deriveRegistrableDomain('shop.example.com.br')).toBe('example.com.br');
    expect(deriveRegistrableDomain('portal.jd.co.kr')).toBe('jd.co.kr');
  });

  it('passes IP literals and single-label hosts through', () => {
    expect(deriveRegistrableDomain('192.168.0.1')).toBe('192.168.0.1');
    expect(deriveRegistrableDomain('localhost')).toBe('localhost');
    expect(deriveRegistrableDomain('[::1]')).toBe('[::1]');
  });

  it('is case-insensitive', () => {
    expect(deriveRegistrableDomain('WWW.EXAMPLE.COM')).toBe('example.com');
  });
});

describe('toChallengeCookie / extractChallengeCookies', () => {
  const raws: RawCookie[] = [
    {
      name: 'cf_clearance',
      value: 't1',
      domain: 'www.example.com',
      expires: Math.floor(Date.now() / 1000) + 3600,
      secure: true,
      httpOnly: true,
    },
    {
      name: 'sessionid',
      value: 'abc',
      domain: 'www.example.com',
    },
    {
      name: '__cf_bm',
      value: 't2',
      domain: '.example.com',
      expires: Math.floor(Date.now() / 1000) + 1800,
    },
  ];

  it('drops non-challenge cookies', () => {
    const out = extractChallengeCookies(raws, 'https://www.example.com');
    expect(out.map((c) => c.name).sort()).toEqual(['__cf_bm', 'cf_clearance']);
  });

  it('collapses domain to registrable form', () => {
    const out = extractChallengeCookies(raws, 'https://www.example.com');
    for (const c of out) expect(c.domain).toBe('example.com');
  });

  it('records secure/httpOnly and capture timestamp', () => {
    const cookie = toChallengeCookie(raws[0])!;
    expect(cookie.secure).toBe(true);
    expect(cookie.httpOnly).toBe(true);
    expect(new Date(cookie.capturedAt).toString()).not.toBe('Invalid Date');
  });

  it('treats a missing/zero expires as a session cookie', () => {
    const c = toChallengeCookie({ name: 'cf_clearance', value: 'x', domain: 'e.com' });
    expect(c?.expiresAt).toBeUndefined();
  });
});

describe('ChallengeCookieStore', () => {
  let now = 1_700_000_000;
  const clock = () => now;

  beforeEach(() => {
    now = 1_700_000_000;
  });

  it('put and get round-trip', () => {
    const store = new ChallengeCookieStore({ now: clock });
    store.put(mkCookie({ expiresAt: now + 60 }));
    const got = store.get('example.com', 'cf_clearance');
    expect(got?.value).toBe('tokenXYZ');
  });

  it('overwrites on repeat put', () => {
    const store = new ChallengeCookieStore({ now: clock });
    store.put(mkCookie({ value: 'v1' }));
    store.put(mkCookie({ value: 'v2' }));
    expect(store.get('example.com', 'cf_clearance')?.value).toBe('v2');
    expect(store.size()).toBe(1);
  });

  it('prunes expired cookies on get', () => {
    const store = new ChallengeCookieStore({ now: clock });
    store.put(mkCookie({ expiresAt: now - 1 }));
    expect(store.get('example.com', 'cf_clearance')).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('treats session cookies (no expiresAt) as always live', () => {
    const store = new ChallengeCookieStore({ now: clock });
    store.put(mkCookie({ expiresAt: undefined }));
    now += 999_999;
    expect(store.get('example.com', 'cf_clearance')?.value).toBe('tokenXYZ');
  });

  it('listForDomain filters by registrable domain', () => {
    const store = new ChallengeCookieStore({ now: clock });
    store.put(mkCookie({ domain: 'example.com', name: 'cf_clearance' }));
    store.put(mkCookie({ domain: 'other.com', name: 'cf_clearance' }));
    expect(store.listForDomain('example.com').length).toBe(1);
    expect(store.listForDomain('other.com').length).toBe(1);
  });

  it('pruneDomain drops every cookie for a domain', () => {
    const store = new ChallengeCookieStore({ now: clock });
    store.put(mkCookie({ name: 'cf_clearance' }));
    store.put(mkCookie({ name: '__cf_bm', kind: '__cf_bm' }));
    const n = store.pruneDomain('example.com');
    expect(n).toBe(2);
    expect(store.size()).toBe(0);
  });

  it('evictExpired removes only past-due cookies', () => {
    const store = new ChallengeCookieStore({ now: clock });
    store.put(mkCookie({ expiresAt: now - 1, name: 'cf_clearance' }));
    store.put(mkCookie({ expiresAt: now + 60, name: '__cf_bm', kind: '__cf_bm' }));
    expect(store.evictExpired()).toBe(1);
    expect(store.size()).toBe(1);
  });

  it('snapshot + restore round-trips live cookies and drops expired ones', () => {
    const src = new ChallengeCookieStore({ now: clock });
    src.put(mkCookie({ expiresAt: now + 60, name: 'cf_clearance', value: 'live' }));
    src.put(mkCookie({ expiresAt: now - 60, name: '__cf_bm', kind: '__cf_bm', value: 'stale' }));
    const snap = src.snapshot();
    expect(snap.cookies.length).toBe(1);

    const dst = new ChallengeCookieStore({ now: clock });
    const restored = dst.restore(snap);
    expect(restored).toBe(1);
    expect(dst.get('example.com', 'cf_clearance')?.value).toBe('live');
  });

  it('rejects unknown snapshot versions', () => {
    const store = new ChallengeCookieStore({ now: clock });
    // deliberate cast — we're testing the guard
    const bad = { version: 2, updatedAt: '', cookies: [] } as unknown as ReturnType<
      ChallengeCookieStore['snapshot']
    >;
    expect(() => store.restore(bad)).toThrow(/unsupported/);
  });
});
