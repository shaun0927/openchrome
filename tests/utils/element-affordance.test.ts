/// <reference types="jest" />

import { classifyElementAffordance, formatAffordancePrefix, getAffordanceMarker } from '../../src/utils/element-affordance';

describe('element affordance classifier', () => {
  test.each([
    [{ tagName: 'input', type: 'text' }, 'text-input', '# '],
    [{ tagName: 'input', type: 'search' }, 'text-input', '# '],
    [{ tagName: 'textarea' }, 'text-input', '# '],
    [{ role: 'textbox' }, 'text-input', '# '],
    [{ tagName: 'div', contentEditable: 'true' }, 'text-input', '# '],
    [{ tagName: 'a', href: '/home' }, 'link', '@ '],
    [{ role: 'link' }, 'link', '@ '],
    [{ tagName: 'button' }, 'control', '$ '],
    [{ tagName: 'input', type: 'checkbox' }, 'control', '$ '],
    [{ role: 'combobox' }, 'control', '$ '],
    [{ tagName: 'img' }, 'visual', '% '],
    [{ role: 'image' }, 'visual', '% '],
    [{ tagName: 'p' }, 'text', ''],
  ])('classifies %o as %s', (input, expectedKind, expectedPrefix) => {
    expect(classifyElementAffordance(input)).toBe(expectedKind);
    expect(formatAffordancePrefix(input)).toBe(expectedPrefix);
  });

  test('does not mark hidden inputs as actionable', () => {
    expect(getAffordanceMarker({ tagName: 'input', type: 'hidden' })).toBe('');
  });

  test('treats password fields as text-insertable markers without exposing values', () => {
    expect(getAffordanceMarker({ tagName: 'input', type: 'password' })).toBe('#');
  });
});
