import { evaluate } from '../../src/contracts/evaluator';
import type { AssertionContext } from '../../src/contracts/evaluator';

function ctx(over: Partial<AssertionContext> = {}): AssertionContext {
  return {
    url: 'https://example.com/',
    bodyText: 'Welcome to Example',
    domText: () => '',
    domCount: () => 0,
    hasDialog: false,
    ...over,
  };
}

describe('evaluate — url', () => {
  test('passes when pattern matches', () => {
    const r = evaluate({ kind: 'url', pattern: 'example\\.com' }, ctx({ url: 'https://example.com/' }));
    expect(r.passed).toBe(true);
    expect(r.assertion_kind).toBe('url');
  });

  test('fails when pattern does not match', () => {
    const r = evaluate({ kind: 'url', pattern: 'not-here' }, ctx());
    expect(r.passed).toBe(false);
    expect(r.details).toMatchObject({ pattern: 'not-here' });
  });

  test('malformed regex falls back to never-match (no throw)', () => {
    const r = evaluate({ kind: 'url', pattern: '[unclosed' }, ctx());
    expect(r.passed).toBe(false);
  });
});

describe('evaluate — dom_text', () => {
  test('default selector "body" reads ctx.bodyText', () => {
    const r = evaluate(
      { kind: 'dom_text', contains: 'Welcome' },
      ctx({ bodyText: 'Welcome traveler' }),
    );
    expect(r.passed).toBe(true);
    expect(r.details.selector).toBe('body');
  });

  test('explicit selector reads via domText()', () => {
    const r = evaluate(
      { kind: 'dom_text', selector: '#title', contains: 'Hello' },
      ctx({
        domText: (sel) => (sel === '#title' ? 'Hello world' : ''),
      }),
    );
    expect(r.passed).toBe(true);
  });

  test('returns truncated haystack_excerpt for long bodies', () => {
    const long = 'x'.repeat(1000);
    const r = evaluate({ kind: 'dom_text', contains: 'x' }, ctx({ bodyText: long }));
    expect(typeof r.details.haystack_excerpt).toBe('string');
    expect((r.details.haystack_excerpt as string).length).toBeLessThan(260);
    expect(r.details.haystack_length).toBe(1000);
  });
});

describe('evaluate — dom_count', () => {
  test('eq pass / fail', () => {
    expect(
      evaluate(
        { kind: 'dom_count', selector: 'button', op: 'eq', value: 3 },
        ctx({ domCount: () => 3 }),
      ).passed,
    ).toBe(true);
    expect(
      evaluate(
        { kind: 'dom_count', selector: 'button', op: 'eq', value: 3 },
        ctx({ domCount: () => 4 }),
      ).passed,
    ).toBe(false);
  });

  test('gte pass / fail', () => {
    expect(
      evaluate(
        { kind: 'dom_count', selector: 'button', op: 'gte', value: 3 },
        ctx({ domCount: () => 5 }),
      ).passed,
    ).toBe(true);
    expect(
      evaluate(
        { kind: 'dom_count', selector: 'button', op: 'gte', value: 3 },
        ctx({ domCount: () => 1 }),
      ).passed,
    ).toBe(false);
  });

  test('lte pass / fail', () => {
    expect(
      evaluate(
        { kind: 'dom_count', selector: 'button', op: 'lte', value: 3 },
        ctx({ domCount: () => 1 }),
      ).passed,
    ).toBe(true);
    expect(
      evaluate(
        { kind: 'dom_count', selector: 'button', op: 'lte', value: 3 },
        ctx({ domCount: () => 5 }),
      ).passed,
    ).toBe(false);
  });

  test('details record actual + expected', () => {
    const r = evaluate(
      { kind: 'dom_count', selector: '.x', op: 'gte', value: 2 },
      ctx({ domCount: () => 7 }),
    );
    expect(r.details).toMatchObject({ actual: 7, expected: 2, op: 'gte' });
  });
});

describe('evaluate — no_dialog', () => {
  test('passes when no dialog is open', () => {
    expect(evaluate({ kind: 'no_dialog' }, ctx({ hasDialog: false })).passed).toBe(true);
  });

  test('fails when a dialog is open', () => {
    expect(evaluate({ kind: 'no_dialog' }, ctx({ hasDialog: true })).passed).toBe(false);
  });

  test('details carry the boolean', () => {
    const r = evaluate({ kind: 'no_dialog' }, ctx({ hasDialog: true }));
    expect(r.details).toEqual({ hasDialog: true });
  });
});

describe('evaluate — network / screenshot_class are PR-10 stubs', () => {
  test('network returns passed=false with unsupported flag', () => {
    const r = evaluate(
      { kind: 'network', url_pattern: '/x', status_in: [200], since: 'contract_enter' },
      ctx(),
    );
    expect(r.passed).toBe(false);
    expect(r.details.unsupported_in_pr9).toBe(true);
  });

  test('screenshot_class returns passed=false with unsupported flag', () => {
    const r = evaluate(
      { kind: 'screenshot_class', class_id: 'x', distance_max: 12 },
      ctx(),
    );
    expect(r.passed).toBe(false);
    expect(r.details.unsupported_in_pr9).toBe(true);
  });
});

describe('evaluate — and/or/not (composite)', () => {
  test('and: passes only when every child passes', () => {
    const c = ctx({ url: 'https://x.com/', bodyText: 'OK' });
    expect(
      evaluate(
        { kind: 'and', children: [
          { kind: 'url', pattern: 'x\\.com' },
          { kind: 'dom_text', contains: 'OK' },
        ] },
        c,
      ).passed,
    ).toBe(true);
    expect(
      evaluate(
        { kind: 'and', children: [
          { kind: 'url', pattern: 'x\\.com' },
          { kind: 'dom_text', contains: 'MISSING' },
        ] },
        c,
      ).passed,
    ).toBe(false);
  });

  test('or: passes when any child passes', () => {
    const c = ctx({ url: 'https://x.com/', bodyText: 'A' });
    expect(
      evaluate(
        { kind: 'or', children: [
          { kind: 'dom_text', contains: 'B' },
          { kind: 'dom_text', contains: 'A' },
        ] },
        c,
      ).passed,
    ).toBe(true);
  });

  test('not: inverts a single child', () => {
    const c = ctx({ hasDialog: true });
    const r = evaluate({ kind: 'not', child: { kind: 'no_dialog' } }, c);
    expect(r.passed).toBe(true);
    expect(r.children).toHaveLength(1);
    expect(r.children![0].passed).toBe(false);
  });

  test('composite evidence preserves children for debugging', () => {
    const r = evaluate(
      { kind: 'and', children: [{ kind: 'no_dialog' }, { kind: 'no_dialog' }] },
      ctx(),
    );
    expect(r.children).toHaveLength(2);
    expect(r.children!.every((c) => c.passed)).toBe(true);
  });
});

describe('evaluate — trace_ref propagation', () => {
  test('trace_ref from ctx is included in evidence', () => {
    const c = ctx({ traceRef: { trace_id: 't1', from_ts: 100, to_ts: 200 } });
    const r = evaluate({ kind: 'no_dialog' }, c);
    expect(r.trace_ref).toEqual({ trace_id: 't1', from_ts: 100, to_ts: 200 });
  });
});
