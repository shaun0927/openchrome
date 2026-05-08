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

  test('multi-token role: any interactive token in the fallback chain promotes the node', () => {
    // ARIA permits a space-separated fallback chain; the user agent
    // honours the first valid token. Earlier code compared the whole
    // string against the role set and missed `<div role="switch checkbox">`,
    // dropping these nodes from the histogram.
    expect(isInteractiveNode({ tagName: 'div', role: 'switch checkbox' })).toBe(true);
    expect(isInteractiveNode({ tagName: 'div', role: 'unknown button' })).toBe(true);
    expect(isInteractiveNode({ tagName: 'div', role: 'heading button' })).toBe(true);
  });

  test('multi-token role with no interactive tokens stays non-interactive', () => {
    expect(isInteractiveNode({ tagName: 'div', role: 'heading note' })).toBe(false);
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
