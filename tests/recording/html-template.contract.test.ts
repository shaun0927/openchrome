/**
 * Tests for html-template.ts — Outcome Contract panel rendering.
 * Covers: pass/fail/inconclusive badges, truncation placeholder, contracts
 * summary row in header, and P2 invariance (no contract data → no panel emitted).
 * Part of #852: replay HTML report enrichment.
 */

import { generateHtmlReport } from '../../src/recording/html-template';
import { RecordingAction, RecordingMetadata, ContractResultEntry } from '../../src/recording/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMetadata(overrides: Partial<RecordingMetadata> = {}): RecordingMetadata {
  return {
    version: 1,
    id: 'rec-20240101-120000-test',
    sessionId: 'sess-abc123',
    startedAt: '2024-01-01T12:00:00.000Z',
    stoppedAt: '2024-01-01T12:05:30.000Z',
    actionCount: 0,
    ...overrides,
  };
}

function makeAction(seq: number, overrides: Partial<RecordingAction> = {}): RecordingAction {
  return {
    seq,
    ts: new Date('2024-01-01T12:00:00.000Z').getTime() + seq * 1000,
    tool: 'navigate',
    args: { url: `https://example${seq}.com` },
    durationMs: 150,
    ok: true,
    summary: `Navigated to example${seq}.com`,
    ...overrides,
  };
}

// ── P2 invariance (no contract data) ──────────────────────────────────────────

describe('generateHtmlReport — P2 invariance (no contract data)', () => {
  it('omits contract-panel when contractResults is undefined', () => {
    const action = makeAction(1);
    const html = generateHtmlReport(makeMetadata(), [action]);

    // CSS defines .verdict-badge / .contract-panel so we check for rendered elements,
    // not just the bare class names (which always appear in the stylesheet).
    expect(html).not.toContain('class="panel-details contract-panel"');
    expect(html).not.toContain('class="verdict-badge');
    expect(html).not.toContain('Contracts (');
  });

  it('omits contract-panel when contractResults is empty array', () => {
    const action = makeAction(1, { contractResults: [] });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).not.toContain('class="panel-details contract-panel"');
    expect(html).not.toContain('class="verdict-badge');
  });

  it('omits contracts summary row from header when no contract data', () => {
    const actions = [makeAction(1), makeAction(2)];
    const html = generateHtmlReport(makeMetadata(), actions);

    // The header row is only present when there are verdicts
    expect(html).not.toContain('Contracts:');
  });

  it('is valid HTML5 with no contract data', () => {
    const html = generateHtmlReport(makeMetadata(), [makeAction(1)]);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });
});

// ── Contract panel rendering ──────────────────────────────────────────────────

describe('generateHtmlReport — contract panel rendering', () => {
  it('renders contract-panel details element when contractResults present', () => {
    const entry: ContractResultEntry = {
      assertion: { kind: 'url', pattern: 'example.com' },
      verdict: 'pass',
    };
    const action = makeAction(1, { contractResults: [entry] });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('contract-panel');
    expect(html).toContain('<details class="panel-details contract-panel">');
  });

  it('renders pass badge with verdict-pass class', () => {
    const entry: ContractResultEntry = {
      assertion: { kind: 'url', pattern: 'example.com' },
      verdict: 'pass',
    };
    const action = makeAction(1, { contractResults: [entry] });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('verdict-pass');
    expect(html).toContain('>pass<');
  });

  it('renders fail badge with verdict-fail class', () => {
    const entry: ContractResultEntry = {
      assertion: { kind: 'dom_text', selector: 'h1', contains: 'NotPresent' },
      verdict: 'fail',
    };
    const action = makeAction(1, { contractResults: [entry] });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('verdict-fail');
    expect(html).toContain('>fail<');
  });

  it('renders inconclusive badge with verdict-inconclusive class', () => {
    const entry: ContractResultEntry = {
      assertion: { kind: 'screenshot_class', class_id: 'login' },
      verdict: 'inconclusive',
    };
    const action = makeAction(1, { contractResults: [entry] });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('verdict-inconclusive');
    expect(html).toContain('>inconclusive<');
  });

  it('renders assertion JSON inside the panel', () => {
    const assertion = { kind: 'url', pattern: 'example.com' };
    const entry: ContractResultEntry = { assertion, verdict: 'pass' };
    const action = makeAction(1, { contractResults: [entry] });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('example.com');
    expect(html).toContain('panel-json');
  });

  it('renders details section when entry has details', () => {
    const entry: ContractResultEntry = {
      assertion: { kind: 'dom_text', selector: 'h1', contains: 'X' },
      verdict: 'fail',
      details: { text_preview: 'Hello World', text_length: 11 },
    };
    const action = makeAction(1, { contractResults: [entry] });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('text_preview');
    expect(html).toContain('Hello World');
  });

  it('renders multiple contract entries in a single action', () => {
    const entries: ContractResultEntry[] = [
      { assertion: { kind: 'url', pattern: 'example.com' }, verdict: 'pass' },
      { assertion: { kind: 'dom_text', selector: 'h1', contains: 'X' }, verdict: 'fail' },
      { assertion: { kind: 'no_dialog' }, verdict: 'inconclusive' },
    ];
    const action = makeAction(1, { contractResults: entries });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('verdict-pass');
    expect(html).toContain('verdict-fail');
    expect(html).toContain('verdict-inconclusive');
    expect(html).toContain('Contracts (3)');
  });

  it('shows count in summary element of details', () => {
    const entries: ContractResultEntry[] = [
      { assertion: { kind: 'url', pattern: 'a' }, verdict: 'pass' },
      { assertion: { kind: 'url', pattern: 'b' }, verdict: 'fail' },
    ];
    const action = makeAction(1, { contractResults: entries });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('Contracts (2)');
  });

  it('escapes XSS in assertion JSON', () => {
    const entry: ContractResultEntry = {
      assertion: { kind: 'url', pattern: '<script>alert(1)</script>' },
      verdict: 'pass',
    };
    const action = makeAction(1, { contractResults: [entry] });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ── Truncation placeholder ────────────────────────────────────────────────────

describe('generateHtmlReport — contract truncation marker', () => {
  it('renders truncation marker when truncated=true placeholder is stored', () => {
    // Simulate what the recorder stores after bounds enforcement
    const truncationPlaceholder = [{ truncated: true, originalBytes: 5000 }] as unknown as ContractResultEntry[];
    const action = makeAction(1, { contractResults: truncationPlaceholder });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('Truncated');
    expect(html).toContain('5000');
    expect(html).toContain('4 KB');
    expect(html).toContain('contract-row truncated');
  });
});

// ── Contracts summary header row ──────────────────────────────────────────────

describe('generateHtmlReport — contracts summary row', () => {
  it('shows contracts summary row when at least one verdict exists', () => {
    const action = makeAction(1, {
      contractResults: [{ assertion: { kind: 'url', pattern: 'a' }, verdict: 'pass' }],
    });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('Contracts:');
    expect(html).toContain('1 pass');
    expect(html).toContain('0 fail');
    expect(html).toContain('0 inconclusive');
  });

  it('aggregates pass/fail/inconclusive across multiple actions', () => {
    const actions = [
      makeAction(1, {
        contractResults: [
          { assertion: {}, verdict: 'pass' },
          { assertion: {}, verdict: 'pass' },
        ],
      }),
      makeAction(2, {
        contractResults: [{ assertion: {}, verdict: 'fail' }],
      }),
      makeAction(3, {
        contractResults: [{ assertion: {}, verdict: 'inconclusive' }],
      }),
    ];
    const html = generateHtmlReport(makeMetadata(), actions);

    expect(html).toContain('2 pass');
    expect(html).toContain('1 fail');
    expect(html).toContain('1 inconclusive');
  });

  it('omits contracts summary row when no verdicts exist across all actions', () => {
    const actions = [makeAction(1), makeAction(2)];
    const html = generateHtmlReport(makeMetadata(), actions);
    expect(html).not.toContain('Contracts:');
  });
});
