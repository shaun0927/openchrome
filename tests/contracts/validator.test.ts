/// <reference types="jest" />

import { validateAssertion } from '../../src/contracts/validator';

describe('validateAssertion', () => {
  test('accepts a well-formed `url` assertion', () => {
    const r = validateAssertion({ kind: 'url', pattern: '^https://example\\.com/?$' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('url');
  });

  test('rejects an invalid regex with a descriptive error', () => {
    const r = validateAssertion({ kind: 'url', pattern: '(' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].path).toBe('$.pattern');
      expect(r.errors[0].message).toMatch(/invalid regex/);
    }
  });

  test('reports unknown `kind` once per node', () => {
    const r = validateAssertion({ kind: 'wat', pattern: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].path).toBe('$.kind');
    }
  });

  test('dom_text accepts default selector', () => {
    const r = validateAssertion({ kind: 'dom_text', contains: 'foo' });
    expect(r.ok).toBe(true);
  });

  test('dom_text rejects non-string contains', () => {
    const r = validateAssertion({ kind: 'dom_text', contains: 42 });
    expect(r.ok).toBe(false);
  });

  test('dom_count requires legal op + non-negative integer value', () => {
    expect(validateAssertion({ kind: 'dom_count', selector: 'a', op: '!=', value: 1 }).ok).toBe(
      false,
    );
    expect(validateAssertion({ kind: 'dom_count', selector: 'a', op: 'eq', value: -1 }).ok).toBe(
      false,
    );
    expect(validateAssertion({ kind: 'dom_count', selector: 'a', op: 'gte', value: 1.5 }).ok).toBe(
      false,
    );
    expect(validateAssertion({ kind: 'dom_count', selector: 'a', op: 'gte', value: 0 }).ok).toBe(
      true,
    );
  });

  test('network requires non-empty status_in and known marker', () => {
    expect(
      validateAssertion({
        kind: 'network',
        url_pattern: 'x',
        status_in: [],
        since: 'contract_enter',
      }).ok,
    ).toBe(false);
    expect(
      validateAssertion({
        kind: 'network',
        url_pattern: 'x',
        status_in: [200],
        since: 'whenever',
      }).ok,
    ).toBe(false);
    expect(
      validateAssertion({
        kind: 'network',
        url_pattern: 'x',
        status_in: [200, 302],
        since: 'last_tool_call',
      }).ok,
    ).toBe(true);
  });

  test('network rejects out-of-range status codes', () => {
    expect(
      validateAssertion({
        kind: 'network',
        url_pattern: 'x',
        status_in: [99],
        since: 'contract_enter',
      }).ok,
    ).toBe(false);
    expect(
      validateAssertion({
        kind: 'network',
        url_pattern: 'x',
        status_in: [600],
        since: 'contract_enter',
      }).ok,
    ).toBe(false);
  });

  test('screenshot_class enforces id charset and 0..64 distance', () => {
    expect(
      validateAssertion({ kind: 'screenshot_class', class_id: '../escape', distance_max: 5 }).ok,
    ).toBe(false);
    expect(
      validateAssertion({ kind: 'screenshot_class', class_id: 'okay', distance_max: 65 }).ok,
    ).toBe(false);
    expect(
      validateAssertion({ kind: 'screenshot_class', class_id: 'okay.v1', distance_max: 12 }).ok,
    ).toBe(true);
  });

  test('no_dialog has no fields to validate', () => {
    expect(validateAssertion({ kind: 'no_dialog' }).ok).toBe(true);
  });

  test('and/or require non-empty children and walk recursively', () => {
    expect(validateAssertion({ kind: 'and', children: [] }).ok).toBe(false);
    const r = validateAssertion({
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^/a$' },
        { kind: 'or', children: [{ kind: 'no_dialog' }] },
      ],
    });
    expect(r.ok).toBe(true);
  });

  test('not requires `child` (singular) and rejects `children`', () => {
    expect(validateAssertion({ kind: 'not', children: [{ kind: 'no_dialog' }] }).ok).toBe(false);
    expect(validateAssertion({ kind: 'not' }).ok).toBe(false);
    expect(validateAssertion({ kind: 'not', child: { kind: 'no_dialog' } }).ok).toBe(true);
  });

  test('errors are batched (LLM can fix many at once)', () => {
    const r = validateAssertion({
      kind: 'and',
      children: [
        { kind: 'dom_count', selector: 'a', op: '!=', value: 1 },
        { kind: 'url', pattern: '(' },
        { kind: 'screenshot_class', class_id: 'bad/id', distance_max: 99 },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Two errors for the screenshot_class node + one for url + one for dom_count.
      expect(r.errors.length).toBeGreaterThanOrEqual(3);
      const paths = r.errors.map((e) => e.path);
      expect(paths.some((p) => p.startsWith('$.children.0'))).toBe(true);
      expect(paths.some((p) => p.startsWith('$.children.1'))).toBe(true);
      expect(paths.some((p) => p.startsWith('$.children.2'))).toBe(true);
    }
  });

  test('rejects non-object input cleanly', () => {
    expect(validateAssertion(null).ok).toBe(false);
    expect(validateAssertion('string').ok).toBe(false);
    expect(validateAssertion([]).ok).toBe(false);
  });
});
