/// <reference types="jest" />

import { evaluate } from '../../src/contracts/evaluate';
import type { EvalContext, NetworkLogEntry } from '../../src/contracts/eval-context';
import { phashFromPng } from '../../src/contracts/phash';
import { encodeRgbaPng, gradientRgba, solidRgba } from './png-fixtures';

interface CtxState {
  url?: string;
  domTextMap?: Record<string, string | null>;
  defaultDomText?: string | null;
  domCountMap?: Record<string, number>;
  network?: NetworkLogEntry[];
  screenshotPng?: Buffer | null;
  hasOpenDialog?: boolean;
  loadScreenshotClass?: EvalContext['loadScreenshotClass'];
}

function mkCtx(state: CtxState): EvalContext {
  return {
    async url() {
      return state.url ?? 'about:blank';
    },
    async domText(selector) {
      if (state.domTextMap && selector !== undefined && selector in state.domTextMap) {
        return state.domTextMap[selector];
      }
      return state.defaultDomText ?? null;
    },
    async domCount(selector) {
      return state.domCountMap?.[selector] ?? 0;
    },
    async networkSince() {
      return state.network ?? [];
    },
    async screenshotPng() {
      return state.screenshotPng ?? null;
    },
    async hasOpenDialog() {
      return state.hasOpenDialog ?? false;
    },
    loadScreenshotClass: state.loadScreenshotClass,
  };
}

describe('evaluate(url)', () => {
  test('passes when regex matches', async () => {
    const r = await evaluate(
      { kind: 'url', pattern: '^https://example\\.com/?$' },
      mkCtx({ url: 'https://example.com' }),
    );
    expect(r.passed).toBe(true);
    expect(r.evidence.assertion_kind).toBe('url');
  });

  test('fails when regex does not match', async () => {
    const r = await evaluate(
      { kind: 'url', pattern: '^https://other\\.com' },
      mkCtx({ url: 'https://example.com' }),
    );
    expect(r.passed).toBe(false);
    expect(r.evidence.details.url).toBe('https://example.com');
  });

  test('captures the live URL in evidence even on pass', async () => {
    const r = await evaluate(
      { kind: 'url', pattern: '.*' },
      mkCtx({ url: 'https://test/' }),
    );
    expect(r.passed).toBe(true);
    expect(r.evidence.details.url).toBe('https://test/');
  });
});

describe('evaluate(dom_text)', () => {
  test('default selector reads body innerText', async () => {
    const r = await evaluate(
      { kind: 'dom_text', contains: 'Welcome' },
      mkCtx({ defaultDomText: 'Welcome to the site' }),
    );
    expect(r.passed).toBe(true);
  });

  test('explicit selector matches', async () => {
    const r = await evaluate(
      { kind: 'dom_text', selector: 'h1', contains: 'Cart' },
      mkCtx({ domTextMap: { h1: 'Cart Total' } }),
    );
    expect(r.passed).toBe(true);
    expect(r.evidence.details.selector).toBe('h1');
  });

  test('fails when selector returns null', async () => {
    const r = await evaluate(
      { kind: 'dom_text', selector: 'h1', contains: 'x' },
      mkCtx({ domTextMap: { h1: null } }),
    );
    expect(r.passed).toBe(false);
    expect(r.evidence.details.text_length).toBe(0);
  });

  test('text preview is truncated for evidence', async () => {
    const long = 'a'.repeat(1000);
    const r = await evaluate(
      { kind: 'dom_text', contains: 'a' },
      mkCtx({ defaultDomText: long }),
    );
    expect(r.passed).toBe(true);
    expect((r.evidence.details.text_preview as string).length).toBeLessThan(long.length);
  });
});

describe('evaluate(dom_count)', () => {
  const cases: { op: 'eq' | 'gte' | 'lte'; observed: number; target: number; pass: boolean }[] = [
    { op: 'eq', observed: 3, target: 3, pass: true },
    { op: 'eq', observed: 2, target: 3, pass: false },
    { op: 'gte', observed: 5, target: 3, pass: true },
    { op: 'gte', observed: 2, target: 3, pass: false },
    { op: 'lte', observed: 1, target: 3, pass: true },
    { op: 'lte', observed: 4, target: 3, pass: false },
  ];
  for (const c of cases) {
    test(`op=${c.op} observed=${c.observed} target=${c.target} → ${c.pass}`, async () => {
      const r = await evaluate(
        { kind: 'dom_count', selector: '.x', op: c.op, value: c.target },
        mkCtx({ domCountMap: { '.x': c.observed } }),
      );
      expect(r.passed).toBe(c.pass);
      expect(r.evidence.details.observed).toBe(c.observed);
    });
  }
});

describe('evaluate(network)', () => {
  const entries: NetworkLogEntry[] = [
    { url: 'https://api.example.com/cart', status: 200, ts: 100 },
    { url: 'https://api.example.com/cart', status: 500, ts: 200 },
    { url: 'https://cdn.example.com/img', status: 200, ts: 300 },
  ];

  test('passes when at least one match satisfies status_in', async () => {
    const r = await evaluate(
      { kind: 'network', url_pattern: '/cart', status_in: [200], since: 'contract_enter' },
      mkCtx({ network: entries }),
    );
    expect(r.passed).toBe(true);
    expect(r.evidence.details.matched_count).toBe(1);
    expect((r.evidence.details.last_match as { url: string }).url).toMatch(/cart/);
  });

  test('treats url_pattern as regex when it parses', async () => {
    const r = await evaluate(
      {
        kind: 'network',
        url_pattern: '^https://api\\.example\\.com/.*$',
        status_in: [200, 500],
        since: 'contract_enter',
      },
      mkCtx({ network: entries }),
    );
    expect(r.passed).toBe(true);
    expect(r.evidence.details.matched_count).toBe(2);
  });

  test('fails cleanly with empty network log', async () => {
    const r = await evaluate(
      { kind: 'network', url_pattern: '/x', status_in: [200], since: 'last_tool_call' },
      mkCtx({ network: [] }),
    );
    expect(r.passed).toBe(false);
    expect(r.evidence.details.scanned_count).toBe(0);
  });
});

describe('evaluate(no_dialog)', () => {
  test('passes when no dialog is open', async () => {
    const r = await evaluate({ kind: 'no_dialog' }, mkCtx({ hasOpenDialog: false }));
    expect(r.passed).toBe(true);
  });

  test('fails when a dialog is open', async () => {
    const r = await evaluate({ kind: 'no_dialog' }, mkCtx({ hasOpenDialog: true }));
    expect(r.passed).toBe(false);
    expect(r.evidence.details.dialog_open).toBe(true);
  });
});

describe('evaluate(screenshot_class)', () => {
  test('uses ctx.loadScreenshotClass when provided', async () => {
    const png = encodeRgbaPng(32, 32, gradientRgba(32, 32));
    const expectedHash = phashFromPng(png);
    const cls = {
      threshold: 12,
      score: jest.fn().mockReturnValue({ distance: 5, exemplar: '0001' }),
    };
    const r = await evaluate(
      { kind: 'screenshot_class', class_id: 'foo', distance_max: 10 },
      mkCtx({
        screenshotPng: png,
        loadScreenshotClass: async (id) => {
          expect(id).toBe('foo');
          return cls;
        },
      }),
    );
    expect(cls.score).toHaveBeenCalledWith(expectedHash);
    expect(r.passed).toBe(true);
    expect(r.evidence.details.distance).toBe(5);
    expect(r.evidence.details.threshold_recommended).toBe(12);
  });

  test('fails passed=false when distance > distance_max', async () => {
    const png = encodeRgbaPng(32, 32, solidRgba(32, 32, [10, 10, 10, 255]));
    const cls = {
      threshold: 4,
      score: () => ({ distance: 20, exemplar: '0000' }),
    };
    const r = await evaluate(
      { kind: 'screenshot_class', class_id: 'a', distance_max: 5 },
      mkCtx({ screenshotPng: png, loadScreenshotClass: async () => cls }),
    );
    expect(r.passed).toBe(false);
  });

  test('returns reasoned failure when no screenshot is available', async () => {
    const r = await evaluate(
      { kind: 'screenshot_class', class_id: 'foo', distance_max: 10 },
      mkCtx({ screenshotPng: null }),
    );
    expect(r.passed).toBe(false);
    expect(r.evidence.details.reason).toMatch(/no screenshot/);
  });
});

describe('evaluate(and / or / not)', () => {
  test('and short-circuits on first failure', async () => {
    const order: string[] = [];
    const ctx = mkCtx({
      url: 'https://example.com',
      domCountMap: { '.late': 5 },
    });
    // Wrap to record evaluation order — proxy through a small helper.
    const trackUrl: typeof ctx.url = async () => {
      order.push('url');
      return ctx.url();
    };
    const trackDom: typeof ctx.domCount = async (s) => {
      order.push(`dom:${s}`);
      return ctx.domCount(s);
    };
    const wrapped = { ...ctx, url: trackUrl, domCount: trackDom } as EvalContext;
    const r = await evaluate(
      {
        kind: 'and',
        children: [
          { kind: 'url', pattern: '^https://other\\.com' }, // fails
          { kind: 'dom_count', selector: '.late', op: 'eq', value: 5 }, // would pass
        ],
      },
      wrapped,
    );
    expect(r.passed).toBe(false);
    expect(order).toEqual(['url']); // never reached the second child
    expect(r.evidence.details.failed_at_index).toBe(0);
  });

  test('or short-circuits on first pass', async () => {
    const r = await evaluate(
      {
        kind: 'or',
        children: [
          { kind: 'url', pattern: '^https://nope\\.com' },
          { kind: 'no_dialog' },
        ],
      },
      mkCtx({ url: 'https://example.com', hasOpenDialog: false }),
    );
    expect(r.passed).toBe(true);
    expect(r.evidence.details.passed_at_index).toBe(1);
  });

  test('or fails when all children fail', async () => {
    const r = await evaluate(
      {
        kind: 'or',
        children: [
          { kind: 'url', pattern: '^/a' },
          { kind: 'url', pattern: '^/b' },
        ],
      },
      mkCtx({ url: 'https://nope/' }),
    );
    expect(r.passed).toBe(false);
  });

  test('not flips the inner result', async () => {
    const r = await evaluate(
      { kind: 'not', child: { kind: 'no_dialog' } },
      mkCtx({ hasOpenDialog: true }),
    );
    expect(r.passed).toBe(true);
    expect(r.evidence.details.child).toBeDefined();
  });
});

describe('evaluate — evidence is JSON-serializable', () => {
  test('every kind round-trips through JSON.stringify', async () => {
    const png = encodeRgbaPng(32, 32, gradientRgba(32, 32));
    const ctx = mkCtx({
      url: 'https://example.com',
      defaultDomText: 'hello world',
      domCountMap: { '.x': 2 },
      network: [{ url: 'https://example.com/api', status: 200, ts: 1 }],
      screenshotPng: png,
      hasOpenDialog: false,
      loadScreenshotClass: async () => ({
        threshold: 8,
        score: () => ({ distance: 1, exemplar: '0000' }),
      }),
    });
    const composite = {
      kind: 'and' as const,
      children: [
        { kind: 'url' as const, pattern: '.*' },
        { kind: 'dom_text' as const, contains: 'hello' },
        { kind: 'dom_count' as const, selector: '.x', op: 'eq' as const, value: 2 },
        {
          kind: 'network' as const,
          url_pattern: 'example',
          status_in: [200],
          since: 'contract_enter' as const,
        },
        { kind: 'screenshot_class' as const, class_id: 'foo', distance_max: 5 },
        { kind: 'no_dialog' as const },
        { kind: 'not' as const, child: { kind: 'no_dialog' as const } },
      ],
    };
    const r = await evaluate(composite, ctx);
    const json = JSON.stringify(r.evidence);
    const parsed = JSON.parse(json);
    expect(parsed.assertion_kind).toBe('and');
    expect(parsed.passed).toBe(false); // last `not` flips no_dialog
    expect(typeof json).toBe('string');
  });

  test('errors inside an evaluator surface as passed=false with details.error', async () => {
    const base = mkCtx({});
    const ctx: EvalContext = {
      ...base,
      url: async () => {
        throw new Error('boom');
      },
    };
    const r = await evaluate({ kind: 'url', pattern: '.*' }, ctx);
    expect(r.passed).toBe(false);
    expect(r.evidence.details.error).toBe('boom');
  });
});
