import { isInteractiveNode } from '../../src/skill/interactive-filter';

describe('isInteractiveNode — native interactive tags', () => {
  test('button is interactive', () => {
    expect(isInteractiveNode({ tagName: 'BUTTON' })).toBe(true);
  });

  test('input/select/textarea are interactive', () => {
    expect(isInteractiveNode({ tagName: 'input' })).toBe(true);
    expect(isInteractiveNode({ tagName: 'select' })).toBe(true);
    expect(isInteractiveNode({ tagName: 'textarea' })).toBe(true);
  });

  test('span without role is not interactive', () => {
    expect(isInteractiveNode({ tagName: 'span' })).toBe(false);
  });
});

describe('isInteractiveNode — media elements', () => {
  test('video without `controls` is NOT interactive', () => {
    // Decorative / auto-playing backgrounds should not inflate the
    // interactive histogram and skew the state hash.
    expect(isInteractiveNode({ tagName: 'video' })).toBe(false);
    expect(isInteractiveNode({ tagName: 'audio' })).toBe(false);
  });

  test('video/audio with `controls` IS interactive', () => {
    expect(isInteractiveNode({ tagName: 'video', hasControls: true })).toBe(true);
    expect(isInteractiveNode({ tagName: 'audio', hasControls: true })).toBe(true);
  });

  test('video without controls but with role=button IS interactive (fall-through)', () => {
    expect(
      isInteractiveNode({ tagName: 'video', hasControls: false, role: 'button' }),
    ).toBe(true);
  });
});

describe('isInteractiveNode — anchor handling', () => {
  test('<a href> is interactive', () => {
    expect(isInteractiveNode({ tagName: 'a', hasHref: true })).toBe(true);
  });

  test('<a> name-anchor (no href, no role) is not interactive', () => {
    expect(isInteractiveNode({ tagName: 'a', hasHref: false })).toBe(false);
  });

  test('<a role="button"> without href IS interactive (role fallthrough)', () => {
    // Common SPA pattern: anchor used as a button via ARIA. Earlier code
    // short-circuited on `tag === 'a'` and never consulted role/tabindex,
    // dropping these from the interactive set.
    expect(
      isInteractiveNode({ tagName: 'a', hasHref: false, role: 'button' }),
    ).toBe(true);
  });

  test('<a tabindex="0"> without href IS interactive (focus fallthrough)', () => {
    expect(
      isInteractiveNode({ tagName: 'a', hasHref: false, tabIndex: 0 }),
    ).toBe(true);
  });

  test('<a contenteditable> without href IS interactive', () => {
    expect(
      isInteractiveNode({ tagName: 'a', hasHref: false, contentEditable: true }),
    ).toBe(true);
  });
});

describe('isInteractiveNode — ARIA roles on non-native tags', () => {
  test('<div role="button"> is interactive', () => {
    expect(isInteractiveNode({ tagName: 'div', role: 'button' })).toBe(true);
  });

  test('<div role="heading"> is NOT interactive', () => {
    expect(isInteractiveNode({ tagName: 'div', role: 'heading' })).toBe(false);
  });

  test('uppercased role is matched (case-insensitive)', () => {
    expect(isInteractiveNode({ tagName: 'div', role: 'BUTTON' })).toBe(true);
  });

  test('multi-token role: first recognised token wins (ARIA 1.2 precedence)', () => {
    // ARIA fallback chain semantics: user agent resolves to the first
    // recognised token. `switch` is a known interactive role → interactive.
    expect(isInteractiveNode({ tagName: 'div', role: 'switch checkbox' })).toBe(true);
    // First token unknown → fall through to next.
    expect(isInteractiveNode({ tagName: 'div', role: 'unknown button' })).toBe(true);
    // First token is a recognised non-interactive role → element is
    // resolved as `heading`, NOT promoted by the trailing `button`.
    // This was a false positive in the earlier "any-token" check.
    expect(isInteractiveNode({ tagName: 'div', role: 'heading button' })).toBe(false);
  });

  test('multi-token role with no interactive tokens stays non-interactive', () => {
    expect(isInteractiveNode({ tagName: 'div', role: 'heading note' })).toBe(false);
  });

  test('all tokens unknown → role chain is treated as non-interactive', () => {
    expect(isInteractiveNode({ tagName: 'div', role: 'totallymade up' })).toBe(false);
  });

  test('first-token precedence respects the full ARIA role universe', () => {
    // `img` is a valid ARIA non-interactive role. The fallback chain
    // `"img button"` must resolve to `img` (non-interactive) — earlier
    // code with a narrow non-interactive set treated `img` as unknown
    // and let the trailing `button` token wrongly win.
    expect(isInteractiveNode({ tagName: 'div', role: 'img button' })).toBe(false);
    expect(isInteractiveNode({ tagName: 'span', role: 'figure link' })).toBe(false);
    expect(isInteractiveNode({ tagName: 'span', role: 'paragraph button' })).toBe(false);
  });
});

describe('isInteractiveNode — focus/edit affordances', () => {
  test('tabindex=0 makes any element interactive', () => {
    expect(isInteractiveNode({ tagName: 'div', tabIndex: 0 })).toBe(true);
  });

  test('tabindex=-1 alone is not interactive', () => {
    expect(isInteractiveNode({ tagName: 'div', tabIndex: -1 })).toBe(false);
  });

  test('contentEditable is interactive', () => {
    expect(isInteractiveNode({ tagName: 'div', contentEditable: true })).toBe(true);
  });
});
