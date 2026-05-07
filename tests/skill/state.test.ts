import {
  computeStateHash,
  canonicalJson,
  type PageSnapshot,
} from '../../src/skill/state';

function snap(over: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://amazon.com/cart',
    interactives: [
      { tagName: 'button', tagPath: 'body>div>button', role: 'button' },
      { tagName: 'a', tagPath: 'body>nav>a', hasHref: true },
      { tagName: 'input', tagPath: 'body>form>input' },
    ],
    headings: ['Your Shopping Cart'],
    landmarks: { cartBadge: true },
    ...over,
  };
}

describe('computeStateHash — determinism', () => {
  test('identical snapshots produce identical hashes', () => {
    const a = computeStateHash(snap());
    const b = computeStateHash(snap());
    expect(a.hash).toBe(b.hash);
  });

  test('hash is 16 hex chars (64-bit truncated SHA-256)', () => {
    const r = computeStateHash(snap());
    expect(r.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test('reordering interactive elements does not change the hash', () => {
    const a = computeStateHash(
      snap({
        interactives: [
          { tagName: 'a', tagPath: 'body>nav>a', hasHref: true },
          { tagName: 'button', tagPath: 'body>div>button', role: 'button' },
        ],
      }),
    );
    const b = computeStateHash(
      snap({
        interactives: [
          { tagName: 'button', tagPath: 'body>div>button', role: 'button' },
          { tagName: 'a', tagPath: 'body>nav>a', hasHref: true },
        ],
      }),
    );
    expect(a.hash).toBe(b.hash);
  });

  test('reordering headings does not change the hash', () => {
    const a = computeStateHash(snap({ headings: ['One', 'Two'] }));
    const b = computeStateHash(snap({ headings: ['Two', 'One'] }));
    expect(a.hash).toBe(b.hash);
  });

  test('utm_ params do not affect the hash (URL normalization)', () => {
    const a = computeStateHash(snap({ url: 'https://amazon.com/cart' }));
    const b = computeStateHash(snap({ url: 'https://amazon.com/cart?utm_source=email' }));
    expect(a.hash).toBe(b.hash);
  });
});

describe('computeStateHash — sensitivity', () => {
  test('logged-in vs logged-out (loginForm landmark) produce different hashes', () => {
    const out = computeStateHash(snap({ landmarks: { loginForm: true } }));
    const inn = computeStateHash(snap({ landmarks: {} }));
    expect(out.hash).not.toBe(inn.hash);
  });

  test('empty cart vs has-item (cartBadge landmark) differ', () => {
    const empty = computeStateHash(snap({ landmarks: {} }));
    const has = computeStateHash(snap({ landmarks: { cartBadge: true } }));
    expect(empty.hash).not.toBe(has.hash);
  });

  test('different URL paths produce different hashes', () => {
    const a = computeStateHash(snap({ url: 'https://amazon.com/cart' }));
    const b = computeStateHash(snap({ url: 'https://amazon.com/checkout' }));
    expect(a.hash).not.toBe(b.hash);
  });

  test('captcha challenge bit flips the hash', () => {
    const a = computeStateHash(snap({ landmarks: { cartBadge: true } }));
    const b = computeStateHash(snap({ landmarks: { cartBadge: true, captchaChallenge: true } }));
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('computeStateHash — evidence object', () => {
  test('evidence carries normalized URL and dropped params', () => {
    const r = computeStateHash(snap({ url: 'https://amazon.com/cart?utm_source=x&q=1' }));
    expect(r.evidence.url_normalized).toBe('https://amazon.com/cart?q=1');
    expect(r.evidence.url_dropped_params).toEqual(['utm_source']);
  });

  test('evidence interactive_histogram is sorted by tag-path', () => {
    const r = computeStateHash(snap());
    const paths = r.evidence.interactive_histogram.map(([p]) => p);
    expect(paths).toEqual([...paths].sort());
  });

  test('evidence heading_set is unique + sorted', () => {
    const r = computeStateHash(snap({ headings: ['B', 'A', 'B', '  '] }));
    expect(r.evidence.heading_set).toEqual(['A', 'B']);
  });

  test('evidence landmark_flags is a 5-bit bitmap', () => {
    const r = computeStateHash(
      snap({ landmarks: { loginForm: true, captchaChallenge: true } }),
    );
    // Bit order: loginForm=0, paymentFields=1, cartBadge=2, modalOverlay=3, captcha=4
    expect(r.evidence.landmark_flags).toBe(0b10001);
  });

  test('hash_components_version is set to 1', () => {
    expect(computeStateHash(snap()).evidence.hash_components_version).toBe(1);
  });

  test('non-interactive elements (e.g. role=heading) do not contribute', () => {
    const r = computeStateHash(
      snap({
        interactives: [
          { tagName: 'div', tagPath: 'body>div', role: 'heading' },
          { tagName: 'a', tagPath: 'body>a', hasHref: true },
        ],
      }),
    );
    expect(r.evidence.interactive_node_count).toBe(1);
  });
});

describe('canonicalJson — key sorting', () => {
  test('sorts object keys recursively', () => {
    const out = canonicalJson({ b: 2, a: { z: 1, y: 2 } });
    expect(out).toBe('{"a":{"y":2,"z":1},"b":2}');
  });

  test('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});
