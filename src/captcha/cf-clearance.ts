/**
 * Cloudflare challenge cookie retrieval (`cf_clearance` scheme).
 *
 * Motivation
 * ----------
 * openchrome's `src/captcha/` already handles Turnstile / reCAPTCHA solve
 * flows, and `src/gates/` detects Cloudflare bot-check interstitials (see
 * PR #1517). What is missing is the *cookie-retrieval* half: once the
 * challenge has been passed — either by a solver, a real user, or a
 * FlareSolverr-style headless pass — the site issues a `cf_clearance`
 * cookie that must be captured, persisted, and replayed on subsequent
 * requests to the same registrable domain.
 *
 * This module contributes the contract:
 *
 *   - a typed `ChallengeCookie` shape covering `cf_clearance`,
 *     `__cf_bm`, `_cfuvid`, `cf_chl_*` and unknown-but-cf-prefixed cookies.
 *   - a `ChallengeCookieStore` with the small operations openchrome needs
 *     (put, get, list, evict-expired, prune-by-domain).
 *   - `extractChallengeCookies(rawCookies, url)` — filter arbitrary
 *     browser-cookie jars down to the challenge-cookie subset.
 *   - `deriveRegistrableDomain(hostname)` — public-suffix-ish grouping
 *     helper so `docs.foo.co.uk` and `www.foo.co.uk` share one bucket.
 *
 * References
 * ----------
 * - FlareSolverr (MIT) — https://github.com/FlareSolverr/FlareSolverr —
 *   showed the cf_clearance retrieval flow (solve challenge, harvest cookie,
 *   replay).
 * - SeleniumBase (MIT) — https://github.com/seleniumbase/SeleniumBase —
 *   documents the cookie scheme and challenge families.
 *
 * Clean-room re-implementation. No FlareSolverr / SeleniumBase source was
 * copied.
 */

/**
 * The subset of cookies openchrome treats as "challenge-issued". Everything
 * else stays in the regular browser cookie jar untouched.
 *
 *   cf_clearance   — the persistent clearance cookie. Highest-value; TTL is
 *                    site-configured (typically 30 min to hours).
 *   __cf_bm        — bot-management short-lived cookie (~30 min).
 *   _cfuvid        — unique visitor id used by rate-limiting rules.
 *   cf_chl_*       — challenge-transient cookies (drop after solve).
 *   other-cf       — any other `cf_`- / `__cf`-prefixed cookie, preserved
 *                    conservatively.
 */
export type ChallengeCookieKind =
  | 'cf_clearance'
  | '__cf_bm'
  | '_cfuvid'
  | 'cf_chl'
  | 'other-cf';

export interface ChallengeCookie {
  kind: ChallengeCookieKind;
  name: string;
  value: string;
  /** Registrable domain the cookie applies to (see deriveRegistrableDomain). */
  domain: string;
  /** UNIX epoch seconds. `undefined` = session cookie. */
  expiresAt?: number;
  /** True if the cookie was set with the Secure flag. */
  secure: boolean;
  /** True if the cookie was set with HttpOnly. */
  httpOnly: boolean;
  /** ISO timestamp when openchrome captured the cookie. */
  capturedAt: string;
}

/**
 * A raw cookie as delivered by CDP / Playwright / puppeteer-core. Only the
 * fields this module needs are typed — everything else is ignored.
 */
export interface RawCookie {
  name: string;
  value: string;
  domain: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
}

/**
 * Classify a cookie name. Returns `null` when the cookie is not
 * challenge-related.
 */
export function classifyCookieName(name: string): ChallengeCookieKind | null {
  if (name === 'cf_clearance') return 'cf_clearance';
  if (name === '__cf_bm') return '__cf_bm';
  if (name === '_cfuvid') return '_cfuvid';
  if (name.startsWith('cf_chl_')) return 'cf_chl';
  if (name.startsWith('cf_') || name.startsWith('__cf')) return 'other-cf';
  return null;
}

/**
 * Derive a registrable-domain-ish key from a hostname. This is deliberately
 * lightweight — a full Public Suffix List match would be preferable, but
 * would bloat the runtime. The heuristic covers the common cases:
 *
 *   - two-label ccTLDs (`co.uk`, `com.br`, `co.kr`, `co.jp`, `com.au`, …)
 *     collapse to `<sld>.<cctld>`.
 *   - everything else collapses to `<sld>.<tld>`.
 *   - IP addresses and single-label hosts pass through unchanged.
 *
 * If openchrome later adopts a PSL library, callers can swap this out — the
 * `ChallengeCookieStore` never looks at the domain string beyond equality.
 */
export function deriveRegistrableDomain(hostname: string): string {
  const clean = hostname.replace(/^\./, '').toLowerCase();
  if (isIpLiteral(clean) || !clean.includes('.')) return clean;

  const parts = clean.split('.');
  const twoLabelCcTld = new Set([
    'co.uk', 'com.br', 'co.kr', 'co.jp', 'com.au',
    'com.mx', 'co.in', 'co.nz', 'co.za', 'com.sg',
    'com.hk', 'com.tw', 'ne.jp', 'or.jp', 'ac.jp',
    'co.il', 'com.tr', 'com.ar', 'org.uk', 'ac.uk',
  ]);

  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join('.');
    if (twoLabelCcTld.has(lastTwo)) return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.startsWith('[') && host.endsWith(']')) return true;
  return false;
}

/**
 * Turn a raw cookie into a `ChallengeCookie`, or return `null` if the
 * cookie does not belong to the challenge namespace.
 */
export function toChallengeCookie(raw: RawCookie): ChallengeCookie | null {
  const kind = classifyCookieName(raw.name);
  if (!kind) return null;
  return {
    kind,
    name: raw.name,
    value: raw.value,
    domain: deriveRegistrableDomain(raw.domain),
    expiresAt: raw.expires && raw.expires > 0 ? Math.floor(raw.expires) : undefined,
    secure: raw.secure === true,
    httpOnly: raw.httpOnly === true,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Given a raw cookie jar and the URL the cookies were observed on, return
 * the challenge-cookie subset with registrable-domain keys. Cookies whose
 * host does not resolve to the URL's registrable domain are still included
 * (Cloudflare frequently sets cookies on a parent domain).
 */
export function extractChallengeCookies(rawCookies: RawCookie[], _url: string): ChallengeCookie[] {
  const out: ChallengeCookie[] = [];
  for (const raw of rawCookies) {
    const cookie = toChallengeCookie(raw);
    if (cookie) out.push(cookie);
  }
  return out;
}

/**
 * Options for a `ChallengeCookieStore` implementation.
 */
export interface ChallengeCookieStoreOptions {
  /** Clock override for tests. */
  now?: () => number;
  /** If provided, the store persists to disk under this path. */
  persistPath?: string;
}

export interface ChallengeCookieStoreSnapshot {
  version: 1;
  updatedAt: string;
  cookies: ChallengeCookie[];
}

/**
 * In-memory `ChallengeCookieStore`. Keyed by (domain, name). New writes
 * overwrite prior values; expired cookies are pruned on read.
 */
export class ChallengeCookieStore {
  private cookies: Map<string, ChallengeCookie> = new Map();
  private readonly now: () => number;

  constructor(private readonly options: ChallengeCookieStoreOptions = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private key(domain: string, name: string): string {
    return `${domain}::${name}`;
  }

  put(cookie: ChallengeCookie): void {
    this.cookies.set(this.key(cookie.domain, cookie.name), cookie);
  }

  putMany(cookies: ChallengeCookie[]): number {
    let n = 0;
    for (const c of cookies) {
      this.put(c);
      n++;
    }
    return n;
  }

  get(domain: string, name: string): ChallengeCookie | undefined {
    const cookie = this.cookies.get(this.key(domain, name));
    if (!cookie) return undefined;
    if (this.isExpired(cookie)) {
      this.cookies.delete(this.key(domain, name));
      return undefined;
    }
    return cookie;
  }

  /** Get every non-expired cookie for a registrable domain. */
  listForDomain(domain: string): ChallengeCookie[] {
    const out: ChallengeCookie[] = [];
    const expired: string[] = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.domain !== domain) continue;
      if (this.isExpired(cookie)) {
        expired.push(key);
        continue;
      }
      out.push(cookie);
    }
    for (const key of expired) this.cookies.delete(key);
    return out;
  }

  /** Return every non-expired cookie in the store. */
  listAll(): ChallengeCookie[] {
    const out: ChallengeCookie[] = [];
    const expired: string[] = [];
    for (const [key, cookie] of this.cookies) {
      if (this.isExpired(cookie)) {
        expired.push(key);
        continue;
      }
      out.push(cookie);
    }
    for (const key of expired) this.cookies.delete(key);
    return out;
  }

  /** Drop every cookie for a registrable domain. */
  pruneDomain(domain: string): number {
    let n = 0;
    for (const [key, cookie] of this.cookies) {
      if (cookie.domain === domain) {
        this.cookies.delete(key);
        n++;
      }
    }
    return n;
  }

  /** Drop every expired cookie. Returns the number pruned. */
  evictExpired(): number {
    let n = 0;
    for (const [key, cookie] of this.cookies) {
      if (this.isExpired(cookie)) {
        this.cookies.delete(key);
        n++;
      }
    }
    return n;
  }

  size(): number {
    return this.cookies.size;
  }

  isExpired(cookie: ChallengeCookie): boolean {
    if (cookie.expiresAt === undefined) return false;
    return cookie.expiresAt <= this.now();
  }

  snapshot(): ChallengeCookieStoreSnapshot {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      cookies: this.listAll(),
    };
  }

  /** Hydrate from a previously produced snapshot. Expired cookies are dropped. */
  restore(snapshot: ChallengeCookieStoreSnapshot): number {
    if (snapshot.version !== 1) {
      throw new Error(`unsupported ChallengeCookieStore snapshot version: ${snapshot.version}`);
    }
    let n = 0;
    for (const cookie of snapshot.cookies) {
      if (this.isExpired(cookie)) continue;
      this.put(cookie);
      n++;
    }
    return n;
  }
}
