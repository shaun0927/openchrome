import { validateAssertion } from '../../src/contracts/validator';

describe('validateAssertion — happy paths', () => {
  test('valid url assertion → no errors', () => {
    expect(validateAssertion({ kind: 'url', pattern: 'amazon\\.com/cart' })).toEqual([]);
  });

  test('valid dom_text with default selector → no errors', () => {
    expect(validateAssertion({ kind: 'dom_text', contains: 'Order Placed' })).toEqual([]);
  });

  test('valid dom_count → no errors', () => {
    expect(
      validateAssertion({ kind: 'dom_count', selector: 'button', op: 'gte', value: 1 }),
    ).toEqual([]);
  });

  test('valid no_dialog → no errors', () => {
    expect(validateAssertion({ kind: 'no_dialog' })).toEqual([]);
  });

  test('valid screenshot_class → no errors', () => {
    expect(
      validateAssertion({
        kind: 'screenshot_class',
        class_id: 'order-confirmation/v3',
        distance_max: 12,
      }),
    ).toEqual([]);
  });

  test('valid network → no errors', () => {
    expect(
      validateAssertion({
        kind: 'network',
        url_pattern: '/checkout/.*',
        status_in: [200, 201],
        since: 'contract_enter',
      }),
    ).toEqual([]);
  });

  test('nested composite (and/or/not) → no errors', () => {
    expect(
      validateAssertion({
        kind: 'and',
        children: [
          { kind: 'url', pattern: '/cart' },
          { kind: 'or', children: [{ kind: 'no_dialog' }, { kind: 'dom_text', contains: 'OK' }] },
          { kind: 'not', child: { kind: 'no_dialog' } },
        ],
      }),
    ).toEqual([]);
  });
});

describe('validateAssertion — structural failures', () => {
  test('non-object input → wrong_type', () => {
    expect(validateAssertion(null)).toEqual([
      { path: '$', code: 'wrong_type', message: 'expected object' },
    ]);
    expect(validateAssertion('hello')).toHaveLength(1);
    expect(validateAssertion([])).toHaveLength(1);
  });

  test('missing kind → missing_field', () => {
    const errors = validateAssertion({ pattern: 'x' });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('missing_field');
    expect(errors[0].path).toBe('$.kind');
  });

  test('unknown kind → unknown_kind (does not crash)', () => {
    const errors = validateAssertion({ kind: 'never-existed' });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('unknown_kind');
  });
});

describe('validateAssertion — per-kind field rules', () => {
  test('url with invalid regex → invalid_regex', () => {
    const errors = validateAssertion({ kind: 'url', pattern: '[unclosed' });
    expect(errors.some((e) => e.code === 'invalid_regex')).toBe(true);
  });

  test('url without pattern → missing_field', () => {
    expect(validateAssertion({ kind: 'url' })).toEqual([
      expect.objectContaining({ code: 'missing_field', path: '$.pattern' }),
    ]);
  });

  test('dom_text without contains → missing_field', () => {
    const errors = validateAssertion({ kind: 'dom_text' });
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('$.contains');
  });

  test('dom_count with bogus op → unknown_enum', () => {
    const errors = validateAssertion({
      kind: 'dom_count',
      selector: 'button',
      op: '==',
      value: 1,
    });
    expect(errors.some((e) => e.code === 'unknown_enum' && e.path === '$.op')).toBe(true);
  });

  test('dom_count with non-finite value → wrong_type', () => {
    const errors = validateAssertion({
      kind: 'dom_count',
      selector: 'button',
      op: 'eq',
      value: Number.POSITIVE_INFINITY,
    });
    expect(errors.some((e) => e.path === '$.value')).toBe(true);
  });

  test('screenshot_class distance_max out of [0,64] → out_of_range', () => {
    const errors = validateAssertion({
      kind: 'screenshot_class',
      class_id: 'x',
      distance_max: 100,
    });
    expect(errors.some((e) => e.code === 'out_of_range' && e.path === '$.distance_max')).toBe(true);
  });

  test('network with bogus since → unknown_enum', () => {
    const errors = validateAssertion({
      kind: 'network',
      url_pattern: '/x',
      status_in: [200],
      since: 'bogus',
    });
    expect(errors.some((e) => e.code === 'unknown_enum' && e.path === '$.since')).toBe(true);
  });

  test('network with non-array status_in → wrong_type', () => {
    const errors = validateAssertion({
      kind: 'network',
      url_pattern: '/x',
      status_in: 200,
      since: 'contract_enter',
    });
    expect(errors.some((e) => e.path === '$.status_in')).toBe(true);
  });
});

describe('validateAssertion — composite rules', () => {
  test('and with empty children → empty_children', () => {
    const errors = validateAssertion({ kind: 'and', children: [] });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('empty_children');
  });

  test('and with non-array children → wrong_type', () => {
    const errors = validateAssertion({ kind: 'and', children: 'oops' });
    expect(errors[0].code).toBe('wrong_type');
  });

  test('not with `children` instead of `child` → missing_field', () => {
    const errors = validateAssertion({
      kind: 'not',
      children: [{ kind: 'no_dialog' }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('$.child');
  });

  test('not with single child → no errors', () => {
    expect(validateAssertion({ kind: 'not', child: { kind: 'no_dialog' } })).toEqual([]);
  });

  test('errors aggregate across the tree (batch reporting)', () => {
    const errors = validateAssertion({
      kind: 'and',
      children: [
        { kind: 'url' /* missing pattern */ },
        { kind: 'dom_count', selector: 'x', op: '?', value: 'oops' },
        { kind: 'not', children: [] },
      ],
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
    // path stamps include the array index
    expect(errors.some((e) => e.path.startsWith('$.children[0]'))).toBe(true);
    expect(errors.some((e) => e.path.startsWith('$.children[1]'))).toBe(true);
    expect(errors.some((e) => e.path.startsWith('$.children[2]'))).toBe(true);
  });
});
