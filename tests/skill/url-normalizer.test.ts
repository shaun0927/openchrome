import { INVALID_URL_SENTINEL, normalizeUrl, TRACKING_PARAM_PATTERNS } from '../../src/skill/url-normalizer';

describe('normalizeUrl — host and fragment', () => {
  test('lowercases hostname', () => {
    expect(normalizeUrl('https://EXAMPLE.com/path').url).toBe('https://example.com/path');
  });

  test('drops hash fragment', () => {
    expect(normalizeUrl('https://x.com/p#section').url).toBe('https://x.com/p');
  });

  test('preserves path case (paths are case-sensitive)', () => {
    expect(normalizeUrl('https://x.com/MyPath').url).toBe('https://x.com/MyPath');
  });
});

describe('normalizeUrl — tracking params', () => {
  test('strips utm_* params', () => {
    const r = normalizeUrl('https://x.com/?utm_source=a&utm_medium=b&q=hello');
    expect(r.url).toBe('https://x.com/?q=hello');
    expect(r.droppedParams).toEqual(['utm_medium', 'utm_source']);
  });

  test('strips known single-name params (fbclid, gclid, msclkid)', () => {
    expect(normalizeUrl('https://x/?fbclid=abc').url).toBe('https://x/');
    expect(normalizeUrl('https://x/?gclid=abc').url).toBe('https://x/');
    expect(normalizeUrl('https://x/?msclkid=abc').url).toBe('https://x/');
  });

  test('strips Amazon pd_rd_* family', () => {
    const r = normalizeUrl('https://amazon.com/?pd_rd_w=abc&pd_rd_r=xyz&node=42');
    expect(r.url).toBe('https://amazon.com/?node=42');
    expect(r.droppedParams).toEqual(['pd_rd_r', 'pd_rd_w']);
  });

  test('TRACKING_PARAM_PATTERNS is the source of truth (visible to consumers)', () => {
    expect(TRACKING_PARAM_PATTERNS.length).toBeGreaterThan(5);
    expect(TRACKING_PARAM_PATTERNS.some((re) => re.test('utm_source'))).toBe(true);
  });
});

describe('normalizeUrl — query stability', () => {
  test('sorts query keys alphabetically', () => {
    const a = normalizeUrl('https://x/?b=1&a=2&c=3').url;
    const b = normalizeUrl('https://x/?c=3&a=2&b=1').url;
    expect(a).toBe(b);
    expect(a).toBe('https://x/?a=2&b=1&c=3');
  });

  test('sorts equal keys by value (deterministic)', () => {
    const r = normalizeUrl('https://x/?a=2&a=1').url;
    expect(r).toBe('https://x/?a=1&a=2');
  });

  test('returns sorted droppedParams for evidence stability', () => {
    const r = normalizeUrl('https://x/?utm_term=a&utm_medium=b&utm_source=c');
    expect(r.droppedParams).toEqual(['utm_medium', 'utm_source', 'utm_term']);
  });
});

describe('normalizeUrl — invalid input (total function, no throw)', () => {
  test('non-URL string returns the stable sentinel', () => {
    const r = normalizeUrl('not a url');
    expect(r.url).toBe(INVALID_URL_SENTINEL);
    expect(r.droppedParams).toEqual([]);
  });

  test('empty string returns the stable sentinel', () => {
    const r = normalizeUrl('');
    expect(r.url).toBe(INVALID_URL_SENTINEL);
  });

  test('two malformed URLs hash identically (deterministic fallback)', () => {
    const a = normalizeUrl('not a url');
    const b = normalizeUrl('also not a url');
    expect(a.url).toBe(b.url);
  });

  test('sentinel is idempotent under re-normalization', () => {
    // If an upstream stage already emitted the sentinel, normalising it
    // again must produce the same string. A fragment-bearing sentinel
    // would round-trip to a different value because `u.hash = ''` clears
    // it, leaking non-determinism into the state hash.
    const once = normalizeUrl('not a url');
    const twice = normalizeUrl(once.url);
    expect(twice.url).toBe(once.url);
    expect(twice.url).toBe(INVALID_URL_SENTINEL);
  });
});
