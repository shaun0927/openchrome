/// <reference types="jest" />
/**
 * Tests for oc_proxy_hook primitives + handler (#874).
 *
 * Pure-function coverage for the building blocks (glob matcher, upstream
 * parser, auth-decision logic, schema validation) plus a behavioural pass
 * over the MCP handler with the pilot family flag toggled on/off.
 *
 * The egress invariant (I1 — no outbound HTTP from apply/status) is
 * verified in the sibling `egress.test.ts` so this file can stay
 * synchronous and fast.
 */

import {
  compileOriginGlob,
  matchOrigin,
  parseUpstream,
  decideProxyAuth,
  registerOcProxyHookTool,
  getProxyBindingsSnapshot,
  _resetProxyBindingsForTesting,
  __TEST_ONLY__,
} from '../../../src/pilot/proxy/hook';

import * as flags from '../../../src/harness/flags';

// ---------------------------------------------------------------------------
// Glob matcher
// ---------------------------------------------------------------------------

describe('compileOriginGlob / matchOrigin', () => {
  it('exact match', () => {
    expect(matchOrigin('https://example.com', 'https://example.com')).toBe(true);
    expect(matchOrigin('https://example.com', 'https://other.com')).toBe(false);
  });

  it('`*.example.com` matches sub-origins but NOT trailing-dot attacks', () => {
    expect(matchOrigin('*.example.com', 'api.example.com')).toBe(true);
    expect(matchOrigin('*.example.com', 'www.example.com')).toBe(true);
    // The dot before `example` must be literal, not regex `.` (any char).
    expect(matchOrigin('*.example.com', 'exampleXcom')).toBe(false);
    // Trailing-dot extension MUST NOT match — would allow attacker.com to
    // hijack rules intended for *.example.com.
    expect(matchOrigin('*.example.com', 'example.com.attacker.com')).toBe(false);
  });

  it('`https://api.*` matches host prefix', () => {
    expect(matchOrigin('https://api.*', 'https://api.example.com')).toBe(true);
    expect(matchOrigin('https://api.*', 'https://api.other.net')).toBe(true);
    expect(matchOrigin('https://api.*', 'https://www.example.com')).toBe(false);
  });

  it('does NOT match origin with embedded slashes in the wildcard span', () => {
    // `*` is `[^/]*` per the source comment, so it cannot cross a slash.
    expect(matchOrigin('https://*', 'https://example.com/path')).toBe(false);
  });

  it('escapes regex metacharacters in the literal portion', () => {
    // `?` `(` `)` etc. must all be treated as literals; no pattern explosion.
    expect(matchOrigin('https://a?b.example.com', 'https://a?b.example.com')).toBe(true);
    expect(matchOrigin('https://a?b.example.com', 'https://axb.example.com')).toBe(false);
  });

  it('compileOriginGlob returns an anchored RegExp', () => {
    const re = compileOriginGlob('*.example.com');
    expect(re.source.startsWith('^')).toBe(true);
    expect(re.source.endsWith('$')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseUpstream
// ---------------------------------------------------------------------------

describe('parseUpstream', () => {
  it('extracts host, port, user, pass from a fully-credentialled URL', () => {
    const p = parseUpstream('http://alice:s3cret@proxy.example:8080');
    expect(p.hostname).toBe('proxy.example');
    expect(p.port).toBe(8080);
    expect(p.username).toBe('alice');
    expect(p.password).toBe('s3cret');
  });

  it('returns null port when port is absent', () => {
    const p = parseUpstream('http://proxy.example');
    expect(p.port).toBeNull();
  });

  it('returns empty username/password when credentials are absent', () => {
    const p = parseUpstream('http://proxy.example:3128');
    expect(p.username).toBe('');
    expect(p.password).toBe('');
  });

  it('percent-decodes credentials', () => {
    const p = parseUpstream('http://us%40er:p%2Fass@proxy.example:8080');
    expect(p.username).toBe('us@er');
    expect(p.password).toBe('p/ass');
  });

  it('throws on malformed input', () => {
    expect(() => parseUpstream('not a url')).toThrow();
    expect(() => parseUpstream('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// decideProxyAuth — invariant I3
// ---------------------------------------------------------------------------

describe('decideProxyAuth (Fetch.authRequired decision)', () => {
  it('returns ok with credentials when both user and pass are present', () => {
    const d = decideProxyAuth('http://alice:secret@proxy.example:8080');
    expect(d.ok).toBe(true);
    expect(d.username).toBe('alice');
    expect(d.password).toBe('secret');
    expect(d.reason).toBeUndefined();
  });

  it('returns missing_proxy_credentials when both creds absent', () => {
    const d = decideProxyAuth('http://proxy.example:8080');
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('missing_proxy_credentials');
    expect(typeof d.error_message).toBe('string');
    expect(d.username).toBeUndefined();
  });

  it('returns missing_proxy_credentials when only username present', () => {
    const d = decideProxyAuth('http://alice@proxy.example:8080');
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('missing_proxy_credentials');
  });

  it('returns invalid_upstream when URL is unparseable', () => {
    const d = decideProxyAuth('://bogus');
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('invalid_upstream');
  });
});

// ---------------------------------------------------------------------------
// Handler — pilot-gated behaviour (no real CDP target needed; bindings live
// in a module-level state which we reset between tests).
// ---------------------------------------------------------------------------

describe('oc_proxy_hook handler', () => {
  const FAKE_SESSION = 'sess-test';

  beforeEach(() => {
    _resetProxyBindingsForTesting();
    jest.restoreAllMocks();
  });

  function withFlag(enabled: boolean): jest.SpyInstance {
    return jest.spyOn(flags, 'isProxyHookEnabled').mockReturnValue(enabled);
  }

  // Pull the JSON payload out of an MCP result. `content` is typed optional
  // on MCPResult, but the proxy-hook handler always populates it; narrowing
  // here keeps every test concise.
  function payloadOf(result: { content?: Array<{ text?: string }> }): {
    ok: boolean;
    reason?: string;
    applied_rules?: Array<{ ruleTag: string; bindings: Array<{ status: string }> }>;
    error_message?: string;
  } {
    const text = result.content?.[0]?.text;
    if (typeof text !== 'string') throw new Error('handler returned no text payload');
    return JSON.parse(text);
  }

  it('returns disabled when the family flag is off (invariant I4)', async () => {
    withFlag(false);
    const out = await __TEST_ONLY__.handler(FAKE_SESSION, { action: 'status' });
    const payload = payloadOf(out);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('disabled');
    // Bindings remain empty — disabled handler must NOT mutate state.
    expect(getProxyBindingsSnapshot()).toHaveLength(0);
  });

  it('rejects unknown action with invalid_args', async () => {
    withFlag(true);
    const out = await __TEST_ONLY__.handler(FAKE_SESSION, { action: 'noop' });
    const payload = payloadOf(out);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('invalid_args');
  });

  it('apply installs bindings and status reports them', async () => {
    withFlag(true);
    const rules = [
      {
        originPattern: 'https://example.com',
        upstream: 'http://user:pass@127.0.0.1:8888',
        ruleTag: 'r1',
      },
    ];
    const applied = await __TEST_ONLY__.handler(FAKE_SESSION, { action: 'apply', rules });
    const ap = payloadOf(applied);
    expect(ap.ok).toBe(true);
    expect(ap.applied_rules).toHaveLength(1);
    expect(ap.applied_rules![0].ruleTag).toBe('r1');
    expect(ap.applied_rules![0].bindings[0].status).toBe('ok');

    const status = await __TEST_ONLY__.handler(FAKE_SESSION, { action: 'status' });
    const sp = payloadOf(status);
    expect(sp.ok).toBe(true);
    expect(sp.applied_rules).toHaveLength(1);
  });

  it('clear drops all bindings', async () => {
    withFlag(true);
    await __TEST_ONLY__.handler(FAKE_SESSION, {
      action: 'apply',
      rules: [
        { originPattern: 'https://a.com', upstream: 'http://u:p@127.0.0.1:1', ruleTag: 't1' },
      ],
    });
    expect(getProxyBindingsSnapshot()).toHaveLength(1);
    await __TEST_ONLY__.handler(FAKE_SESSION, { action: 'clear' });
    expect(getProxyBindingsSnapshot()).toHaveLength(0);
  });

  it('rotate replaces existing bindings (host owns the new upstream, invariant I2)', async () => {
    withFlag(true);
    await __TEST_ONLY__.handler(FAKE_SESSION, {
      action: 'apply',
      rules: [
        { originPattern: 'https://a.com', upstream: 'http://u:p@1.1.1.1:1', ruleTag: 'old' },
      ],
    });
    await __TEST_ONLY__.handler(FAKE_SESSION, {
      action: 'rotate',
      rules: [
        { originPattern: 'https://a.com', upstream: 'http://u:p@2.2.2.2:2', ruleTag: 'new' },
      ],
    });
    const snap = getProxyBindingsSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].rule.ruleTag).toBe('new');
    expect(snap[0].rule.upstream).toBe('http://u:p@2.2.2.2:2');
  });

  it('rejects malformed upstream URLs at validation time', async () => {
    withFlag(true);
    const out = await __TEST_ONLY__.handler(FAKE_SESSION, {
      action: 'apply',
      rules: [
        { originPattern: 'https://a.com', upstream: 'not a url', ruleTag: 't1' },
      ],
    });
    const p = payloadOf(out);
    expect(p.ok).toBe(false);
    expect(p.reason).toBe('invalid_args');
    // Failure during validation must not mutate state.
    expect(getProxyBindingsSnapshot()).toHaveLength(0);
  });

  it('rejects rules that are not an array', async () => {
    withFlag(true);
    const out = await __TEST_ONLY__.handler(FAKE_SESSION, { action: 'apply', rules: 'oops' });
    const p = payloadOf(out);
    expect(p.ok).toBe(false);
    expect(p.reason).toBe('invalid_args');
  });

  it('rejects rules missing required fields', async () => {
    withFlag(true);
    const out = await __TEST_ONLY__.handler(FAKE_SESSION, {
      action: 'apply',
      rules: [{ originPattern: 'https://a.com', ruleTag: 't1' }], // upstream missing
    });
    const p = payloadOf(out);
    expect(p.ok).toBe(false);
    expect(p.reason).toBe('invalid_args');
  });
});

// ---------------------------------------------------------------------------
// Registration snapshot — invariant I4 surface
// ---------------------------------------------------------------------------

describe('registerOcProxyHookTool', () => {
  beforeEach(() => {
    _resetProxyBindingsForTesting();
  });

  it('registers `oc_proxy_hook` on the supplied server', () => {
    const registered: string[] = [];
    const fakeServer = {
      registerTool(name: string, _handler: unknown, _def: unknown) {
        registered.push(name);
      },
    };
    // Cast through unknown — the test only exercises the registerTool surface.
    registerOcProxyHookTool(fakeServer as unknown as Parameters<typeof registerOcProxyHookTool>[0]);
    expect(registered).toEqual(['oc_proxy_hook']);
  });

  it('definition advertises action enum and oc_-prefixed name', () => {
    expect(__TEST_ONLY__.definition.name).toBe('oc_proxy_hook');
    const schema = __TEST_ONLY__.definition.inputSchema as unknown as {
      properties: { action: { enum: string[] } };
    };
    expect(schema.properties.action.enum.slice().sort()).toEqual(
      ['apply', 'clear', 'rotate', 'status'].sort(),
    );
  });
});
