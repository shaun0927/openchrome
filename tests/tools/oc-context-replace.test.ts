/// <reference types="jest" />
/**
 * Unit tests for the oc_context surface (#873).
 *
 * Covers:
 *   1. Envelope determinism (sorted cookies + storage keys, byte-identical
 *      payload across calls modulo `capturedAt`).
 *   2. Integrity hash — re-computation rejects tampered envelopes without
 *      mutating browser state.
 *   3. Strict-replace semantics — existing cookies for the target origin and
 *      the active-origin web storage are cleared BEFORE the payload is
 *      installed (no merge).
 *   4. Round-trip: an envelope produced by buildEnvelope() applied via
 *      applyContextEnvelopeData() yields the same cookies/storage on the
 *      "destination" page.
 *
 * These tests stay at the unit level — the live-browser E2E lives in
 * `tests/e2e/scenarios/oc-context-roundtrip.e2e.ts`.
 */

import {
  buildEnvelope,
  computeIntegrity,
  canonicalize,
  verifyEnvelopeIntegrity,
  assertEnvelopeImportAllowed,
  registerOcContextTools,
  type ContextEnvelope,
} from '../../src/tools/oc-context';
import {
  captureContextEnvelopeData,
  applyContextEnvelopeData,
  type EnvelopeCapture,
} from '../../src/storage-state/storage-state-manager';
import { setGlobalConfig } from '../../src/config/global';
import * as sessionManagerModule from '../../src/session-manager';
import type { Page } from 'puppeteer-core';

interface CdpCall {
  method: string;
  params: Record<string, unknown>;
}

interface FakeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
}

/**
 * Minimal in-memory page+CDP harness. Mirrors the subset of behaviour the
 * shared walker depends on:
 *   - Network.getAllCookies → returns current cookie jar
 *   - Network.setCookies    → upserts cookies (name+domain+path key)
 *   - Network.deleteCookies → removes by name+domain+path
 *   - page.evaluate(fn)     → runs against `state.localStorage` /
 *                             `state.sessionStorage` for the active origin.
 */
function makeHarness(initial: {
  origin: string;
  cookies?: FakeCookie[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}) {
  const state = {
    origin: initial.origin,
    cookies: [...(initial.cookies ?? [])],
    localStorage: { ...(initial.localStorage ?? {}) },
    sessionStorage: { ...(initial.sessionStorage ?? {}) },
  };
  const calls: CdpCall[] = [];

  const cdpClient = {
    async send<T>(_page: Page, method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      switch (method) {
        case 'Network.getAllCookies':
          return { cookies: [...state.cookies] } as unknown as T;
        case 'Network.setCookies': {
          const incoming = (params.cookies as FakeCookie[]) || [];
          for (const c of incoming) {
            const idx = state.cookies.findIndex(
              (x) => x.name === c.name && x.domain === c.domain && x.path === c.path,
            );
            if (idx >= 0) state.cookies[idx] = { ...c };
            else state.cookies.push({ ...c });
          }
          return {} as T;
        }
        case 'Network.deleteCookies': {
          const name = params.name as string;
          const domain = params.domain as string | undefined;
          const path = params.path as string | undefined;
          state.cookies = state.cookies.filter(
            (c) =>
              !(
                c.name === name &&
                (domain === undefined || c.domain === domain) &&
                (path === undefined || c.path === path)
              ),
          );
          return {} as T;
        }
        default:
          return {} as T;
      }
    },
  };

  const page = {
    url: () => state.origin + '/',
    async evaluate(fn: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown> {
      // Build a minimal `window` proxy that the walker's lambdas can see.
      const sandbox = {
        window: {
          location: { origin: state.origin },
          localStorage: makeStorageAPI(state.localStorage),
          sessionStorage: makeStorageAPI(state.sessionStorage),
          innerWidth: 1280,
          innerHeight: 800,
        },
        navigator: { userAgent: 'TestAgent/1.0' },
      };
      // Provide globals that match what the walker accesses inside the lambda.
      // We Function-execute the source so the sandbox names resolve.
      const src = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`;
      // eslint-disable-next-line no-new-func
      const exec = new Function('window', 'navigator', 'localStorage', 'sessionStorage', `return ${src};`);
      return exec(sandbox.window, sandbox.navigator, sandbox.window.localStorage, sandbox.window.sessionStorage);
    },
  };

  return { page: page as unknown as Page, cdpClient, state, calls };
}

function makeStorageAPI(backing: Record<string, string>) {
  return {
    get length() {
      return Object.keys(backing).length;
    },
    key(i: number): string | null {
      return Object.keys(backing)[i] ?? null;
    },
    getItem(k: string): string | null {
      return Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : null;
    },
    setItem(k: string, v: string): void {
      backing[k] = String(v);
    },
    removeItem(k: string): void {
      delete backing[k];
    },
    clear(): void {
      for (const k of Object.keys(backing)) delete backing[k];
    },
  };
}

const COOKIE_BASE: Omit<FakeCookie, 'name' | 'value'> = {
  domain: 'httpbin.org',
  path: '/',
  expires: -1,
  size: 0,
  httpOnly: false,
  secure: false,
  session: true,
};

function cookie(name: string, value: string, overrides: Partial<FakeCookie> = {}): FakeCookie {
  return { ...COOKIE_BASE, name, value, ...overrides };
}

// ─── canonicalize / integrity ───────────────────────────────────────────────

describe('canonicalize', () => {
  test('object keys are sorted at every depth', () => {
    const a = canonicalize({ b: 1, a: { y: 2, x: 1 } });
    const b = canonicalize({ a: { x: 1, y: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"x":1,"y":2},"b":1}');
  });

  test('arrays preserve order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  test('drops undefined fields, keeps null', () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  test('non-finite numbers become null', () => {
    expect(canonicalize({ x: NaN })).toBe('{"x":null}');
  });
});

describe('computeIntegrity / verifyEnvelopeIntegrity', () => {
  function sampleEnvelope(): ContextEnvelope {
    return buildEnvelope({
      capture: {
        origin: 'https://httpbin.org',
        cookies: [cookie('session', 'abc123'), cookie('user', 'alice')],
        localStorage: { theme: 'dark' },
        sessionStorage: {},
      },
      origin: 'https://httpbin.org',
      includeStorage: true,
      includeHttpAuth: false,
      captureUA: false,
      capturedAt: 1000,
    });
  }

  test('hash is 64-char hex', () => {
    const env = sampleEnvelope();
    expect(env.integrity).toMatch(/^[0-9a-f]{64}$/);
  });

  test('round-trip verify succeeds', () => {
    const env = sampleEnvelope();
    expect(verifyEnvelopeIntegrity(env)).toBeNull();
  });

  test('flipping a cookie value invalidates integrity', () => {
    const env = sampleEnvelope();
    env.cookies[0].value = 'tampered';
    const err = verifyEnvelopeIntegrity(env);
    expect(err).not.toBeNull();
    expect(err).toMatch(/integrity mismatch/);
  });

  test('flipping origin invalidates integrity', () => {
    const env = sampleEnvelope();
    env.origin = 'https://evil.example';
    expect(verifyEnvelopeIntegrity(env)).toMatch(/integrity mismatch/);
  });

  test('rejects wrong version', () => {
    const env = sampleEnvelope();
    (env as unknown as { version: number }).version = 2;
    expect(verifyEnvelopeIntegrity(env)).toMatch(/unsupported envelope version/);
  });

  test('rejects malformed integrity field', () => {
    const env = sampleEnvelope();
    env.integrity = 'short';
    expect(verifyEnvelopeIntegrity(env)).toMatch(/integrity field missing or malformed/);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe('determinism', () => {
  test('cookies sorted by (domain, path, name); storage keys lexicographic', () => {
    const env = buildEnvelope({
      capture: {
        origin: 'https://httpbin.org',
        cookies: [
          cookie('user', 'alice'),
          cookie('session', 'abc'),
          cookie('a', '1', { domain: 'aaa.example' }),
          cookie('z', '1', { domain: 'httpbin.org', path: '/admin' }),
        ],
        localStorage: { z: '1', a: '2', m: '3' },
        sessionStorage: {},
      },
      origin: 'https://httpbin.org',
      includeStorage: true,
      includeHttpAuth: false,
      captureUA: false,
      capturedAt: 1000,
    });

    expect(env.cookies.map((c) => `${c.domain}|${c.path}|${c.name}`)).toEqual([
      'aaa.example|/|a',
      'httpbin.org|/|session',
      'httpbin.org|/|user',
      'httpbin.org|/admin|z',
    ]);
    expect(env.localStorage && Object.keys(env.localStorage)).toEqual(['a', 'm', 'z']);
  });

  test('two exports of the same state yield byte-identical envelopes modulo capturedAt', async () => {
    const h = makeHarness({
      origin: 'https://httpbin.org',
      cookies: [cookie('user', 'alice'), cookie('session', 'abc123')],
      localStorage: { theme: 'dark', lang: 'en' },
      sessionStorage: {},
    });

    const cap1 = await captureContextEnvelopeData(h.page, h.cdpClient, {
      includeCookies: true,
      includeLocalStorage: true,
      includeSessionStorage: true,
    });
    const cap2 = await captureContextEnvelopeData(h.page, h.cdpClient, {
      includeCookies: true,
      includeLocalStorage: true,
      includeSessionStorage: true,
    });

    const env1 = buildEnvelope({
      capture: cap1,
      origin: 'https://httpbin.org',
      includeStorage: true,
      includeHttpAuth: false,
      captureUA: false,
      capturedAt: 1000,
    });
    const env2 = buildEnvelope({
      capture: cap2,
      origin: 'https://httpbin.org',
      includeStorage: true,
      includeHttpAuth: false,
      captureUA: false,
      capturedAt: 1000,
    });

    expect(canonicalize(env1)).toBe(canonicalize(env2));
    expect(env1.integrity).toBe(env2.integrity);
  });

  test('capturedAt is the only field that varies across calls', () => {
    const cap: EnvelopeCapture = {
      origin: 'https://httpbin.org',
      cookies: [cookie('session', 'abc')],
      localStorage: { k: 'v' },
      sessionStorage: {},
    };
    const env1 = buildEnvelope({
      capture: cap,
      origin: 'https://httpbin.org',
      includeStorage: true,
      includeHttpAuth: false,
      captureUA: false,
      capturedAt: 1000,
    });
    const env2 = buildEnvelope({
      capture: cap,
      origin: 'https://httpbin.org',
      includeStorage: true,
      includeHttpAuth: false,
      captureUA: false,
      capturedAt: 2000,
    });

    const { capturedAt: _t1, integrity: _i1, ...rest1 } = env1;
    const { capturedAt: _t2, integrity: _i2, ...rest2 } = env2;
    expect(canonicalize(rest1)).toBe(canonicalize(rest2));
  });
});

// ─── Strict-replace semantics ────────────────────────────────────────────────

describe('applyContextEnvelopeData strict-replace', () => {
  test('clears existing cookies for the envelope origin before installing payload', async () => {
    const dest = makeHarness({
      origin: 'https://httpbin.org',
      cookies: [
        cookie('stale', 'remove_me'),
        cookie('other', 'keep_me', { domain: 'other.example' }),
      ],
      localStorage: { stale: 'remove_me' },
      sessionStorage: {},
    });

    const capture: EnvelopeCapture = {
      origin: 'https://httpbin.org',
      cookies: [cookie('session', 'abc'), cookie('user', 'alice')],
      localStorage: { theme: 'dark' },
      sessionStorage: {},
    };

    const result = await applyContextEnvelopeData(dest.page, dest.cdpClient, capture, {
      origin: 'https://httpbin.org',
    });

    // Order of operations: clear (deleteCookies), then setCookies.
    const methods = dest.calls.map((c) => c.method);
    const firstSet = methods.indexOf('Network.setCookies');
    const lastDelete = methods.lastIndexOf('Network.deleteCookies');
    expect(lastDelete).toBeLessThan(firstSet);

    // Stale cookie for envelope origin is gone; other.example cookie survives.
    const remainingNames = dest.state.cookies.map((c) => c.name).sort();
    expect(remainingNames).toEqual(['other', 'session', 'user']);

    // localStorage was cleared then replaced.
    expect(dest.state.localStorage).toEqual({ theme: 'dark' });

    expect(result.appliedCookies).toBe(2);
    expect(result.appliedStorageKeys).toBe(1);
  });

  test('empty payload still clears existing origin-scoped cookies (strict replace, not merge)', async () => {
    const dest = makeHarness({
      origin: 'https://httpbin.org',
      cookies: [cookie('stale', 'a'), cookie('keep', 'b', { domain: 'other.example' })],
      localStorage: {},
      sessionStorage: {},
    });

    await applyContextEnvelopeData(
      dest.page,
      dest.cdpClient,
      {
        origin: 'https://httpbin.org',
        cookies: [],
        localStorage: {},
        sessionStorage: {},
      },
      { origin: 'https://httpbin.org' },
    );

    // 'stale' (httpbin.org) cleared; 'keep' (other.example) preserved.
    expect(dest.state.cookies.map((c) => c.name).sort()).toEqual(['keep']);
  });

  test('drops expired non-session cookies on apply', async () => {
    const dest = makeHarness({ origin: 'https://httpbin.org', cookies: [] });
    const past = Math.floor(Date.now() / 1000) - 10;

    const capture: EnvelopeCapture = {
      origin: 'https://httpbin.org',
      cookies: [
        { ...cookie('expired', 'x'), session: false, expires: past },
        cookie('alive', 'y'),
      ],
      localStorage: {},
      sessionStorage: {},
    };

    const result = await applyContextEnvelopeData(dest.page, dest.cdpClient, capture, {
      origin: 'https://httpbin.org',
    });

    expect(dest.state.cookies.map((c) => c.name)).toEqual(['alive']);
    expect(result.appliedCookies).toBe(1);
  });

  test('rejects invalid envelope origin before reading or deleting cookies', async () => {
    const dest = makeHarness({
      origin: 'https://httpbin.org',
      cookies: [cookie('stale', 'remove_me'), cookie('other', 'keep_me', { domain: 'other.example' })],
      localStorage: { stale: 'remove_me' },
      sessionStorage: {},
    });

    await expect(
      applyContextEnvelopeData(
        dest.page,
        dest.cdpClient,
        {
          origin: 'not a valid origin',
          cookies: [],
          localStorage: {},
          sessionStorage: {},
        },
        { origin: 'not a valid origin' },
      ),
    ).rejects.toThrow(/invalid envelope origin/);

    expect(dest.calls).toEqual([]);
    expect(dest.state.cookies.map((c) => c.name).sort()).toEqual(['other', 'stale']);
  });

  test('clean envelope with omitted storage maps still clears destination storage via import handler', async () => {
    const envelope = buildEnvelope({
      capture: {
        origin: 'https://httpbin.org',
        cookies: [],
        localStorage: {},
        sessionStorage: {},
      },
      origin: 'https://httpbin.org',
      includeStorage: true,
      includeHttpAuth: false,
      captureUA: false,
      capturedAt: 1000,
    });
    expect(envelope.localStorage).toBeUndefined();
    expect(envelope.sessionStorage).toBeUndefined();

    const dest = makeHarness({
      origin: 'https://httpbin.org',
      cookies: [],
      localStorage: { stale: 'remove_me' },
      sessionStorage: { wizard: 'remove_me' },
    });

    jest.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue({
      getPage: async () => dest.page,
      getCDPClient: () => dest.cdpClient,
    } as unknown as ReturnType<typeof sessionManagerModule.getSessionManager>);

    const handlers: Record<string, (sessionId: string, args: Record<string, unknown>) => Promise<unknown>> = {};
    registerOcContextTools({
      registerTool: (name: string, handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown>) => {
        handlers[name] = handler;
      },
    } as never);

    try {
      const result = await handlers.oc_context_import('session', {
        tabId: 'tab',
        envelope,
      }) as { ok: boolean; appliedStorageKeys: number };

      expect(result.ok).toBe(true);
      expect(dest.state.localStorage).toEqual({});
      expect(dest.state.sessionStorage).toEqual({});
      expect(result.appliedStorageKeys).toBe(0);
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('oc_context_import security policy', () => {
  afterEach(() => {
    setGlobalConfig({ security: { blocked_domains: [] } });
  });

  test('rejects an envelope whose origin is blocked', () => {
    setGlobalConfig({ security: { blocked_domains: ['blocked.example'] } });

    const envelope = buildEnvelope({
      capture: {
        origin: 'https://blocked.example',
        cookies: [],
        localStorage: {},
        sessionStorage: {},
      },
      origin: 'https://blocked.example',
      includeStorage: true,
      includeHttpAuth: false,
      captureUA: false,
      capturedAt: 1000,
    });

    expect(() => assertEnvelopeImportAllowed(envelope)).toThrow(/blocked by security policy/);
  });

  test('rejects imported cookies for blocked domains even when envelope origin is allowed', () => {
    setGlobalConfig({ security: { blocked_domains: ['blocked.example'] } });

    const envelope = buildEnvelope({
      capture: {
        origin: 'https://allowed.example',
        cookies: [cookie('session', 'secret', { domain: 'blocked.example' })],
        localStorage: {},
        sessionStorage: {},
      },
      origin: 'https://allowed.example',
      includeStorage: true,
      includeHttpAuth: false,
      captureUA: false,
      capturedAt: 1000,
    });

    expect(() => assertEnvelopeImportAllowed(envelope)).toThrow(/blocked by security policy/);
  });
});

// ─── End-to-end round-trip (in-memory) ───────────────────────────────────────

describe('export → import round-trip (in-memory)', () => {
  test('cookies + localStorage materialize on destination page', async () => {
    const source = makeHarness({
      origin: 'https://httpbin.org',
      cookies: [cookie('session', 'abc123'), cookie('user', 'alice')],
      localStorage: { theme: 'dark', lang: 'en' },
      sessionStorage: {},
    });

    const cap = await captureContextEnvelopeData(source.page, source.cdpClient, {
      includeCookies: true,
      includeLocalStorage: true,
      includeSessionStorage: true,
    });
    const envelope = buildEnvelope({
      capture: cap,
      origin: 'https://httpbin.org',
      includeStorage: true,
      includeHttpAuth: false,
      captureUA: false,
    });

    // Destination is empty.
    const dest = makeHarness({ origin: 'https://httpbin.org' });

    expect(verifyEnvelopeIntegrity(envelope)).toBeNull();

    await applyContextEnvelopeData(
      dest.page,
      dest.cdpClient,
      {
        origin: envelope.origin,
        cookies: envelope.cookies,
        localStorage: envelope.localStorage ?? {},
        sessionStorage: envelope.sessionStorage ?? {},
      },
      { origin: envelope.origin },
    );

    const destCookieNames = dest.state.cookies.map((c) => c.name).sort();
    expect(destCookieNames).toEqual(['session', 'user']);
    expect(dest.state.localStorage).toEqual({ lang: 'en', theme: 'dark' });
  });
});
