/**
 * Tests for html-template.ts — verify panel rendering.
 * Covers: verify block round-trip, XSS escaping, absent field = no panel.
 * Part of #852: replay HTML report enrichment.
 */

import { generateHtmlReport } from '../../src/recording/html-template';
import { RecordingAction, RecordingMetadata } from '../../src/recording/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMetadata(overrides: Partial<RecordingMetadata> = {}): RecordingMetadata {
  return {
    version: 1,
    id: 'rec-20240101-120000-verify',
    sessionId: 'sess-verify',
    startedAt: '2024-01-01T12:00:00.000Z',
    actionCount: 0,
    ...overrides,
  };
}

function makeAction(seq: number, overrides: Partial<RecordingAction> = {}): RecordingAction {
  return {
    seq,
    ts: new Date('2024-01-01T12:00:00.000Z').getTime() + seq * 1000,
    tool: 'interact',
    args: {},
    durationMs: 200,
    ok: true,
    summary: `action ${seq}`,
    ...overrides,
  };
}

// ── No verify field → no panel ────────────────────────────────────────────────

describe('generateHtmlReport — verify panel absent', () => {
  it('omits verify-panel when verify field is undefined', () => {
    const action = makeAction(1);
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).not.toContain('verify-panel');
    expect(html).not.toContain('<summary>Verify</summary>');
  });
});

// ── Verify panel rendering ────────────────────────────────────────────────────

describe('generateHtmlReport — verify panel present', () => {
  it('renders verify-panel details element when verify field is set', () => {
    const verify = { ax_diff: { changed: true }, screenshot: { phash_distance: 12 } };
    const action = makeAction(1, { verify });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('verify-panel');
    expect(html).toContain('<details class="panel-details verify-panel">');
    expect(html).toContain('<summary>Verify</summary>');
  });

  it('round-trips ax_diff.changed field through the panel JSON', () => {
    const verify: Record<string, unknown> = { ax_diff: { changed: true, added: 2, removed: 1 } };
    const action = makeAction(1, { verify });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('ax_diff');
    expect(html).toContain('changed');
    // JSON keys are HTML-escaped: "changed" becomes &quot;changed&quot;
    expect(html).toContain('&quot;changed&quot;');
    // boolean true is not escaped
    expect(html).toContain(': true');
  });

  it('round-trips screenshot.phash_distance through the panel JSON', () => {
    const verify: Record<string, unknown> = { screenshot: { phash_distance: 42 } };
    const action = makeAction(1, { verify });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('phash_distance');
    expect(html).toContain('42');
  });

  it('renders the JSON inside a panel-json pre element', () => {
    const verify: Record<string, unknown> = { key: 'value' };
    const action = makeAction(1, { verify });
    const html = generateHtmlReport(makeMetadata(), [action]);

    // The pre element with panel-json class is present
    expect(html).toContain('class="panel-json"');
    // JSON keys/values are HTML-escaped (double-quotes become &quot;)
    expect(html).toContain('&quot;key&quot;');
    expect(html).toContain('&quot;value&quot;');
  });

  it('escapes XSS in verify block values', () => {
    const verify: Record<string, unknown> = { url: '<script>alert(1)</script>' };
    const action = makeAction(1, { verify });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles deeply nested verify object', () => {
    const verify: Record<string, unknown> = {
      level1: { level2: { level3: { value: 'deep' } } },
    };
    const action = makeAction(1, { verify });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('level1');
    expect(html).toContain('level2');
    expect(html).toContain('deep');
  });

  it('renders verify panel independently from contract panel', () => {
    const verify: Record<string, unknown> = { screenshot: { phash_distance: 5 } };
    const action = makeAction(1, { verify });
    const html = generateHtmlReport(makeMetadata(), [action]);

    // verify panel present, contract panel absent
    expect(html).toContain('verify-panel');
    expect(html).not.toContain('contract-panel');
  });

  it('renders both verify and contract panels when both fields are set', () => {
    const verify: Record<string, unknown> = { ax_diff: { changed: false } };
    const contractResults = [
      { assertion: { kind: 'url', pattern: 'example.com' }, verdict: 'pass' as const },
    ];
    const action = makeAction(1, { verify, contractResults });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('verify-panel');
    expect(html).toContain('contract-panel');
  });
});
