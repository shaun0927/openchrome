/**
 * Tests for html-template.ts — network panel rendering.
 * Covers: normal rows, truncation at 20 entries, absent field = no panel,
 * status/duration formatting, XSS escaping.
 * Part of #852: replay HTML report enrichment.
 */

import { generateHtmlReport } from '../../src/recording/html-template';
import { RecordingAction, RecordingMetadata, NetworkEntry } from '../../src/recording/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMetadata(overrides: Partial<RecordingMetadata> = {}): RecordingMetadata {
  return {
    version: 1,
    id: 'rec-20240101-120000-network',
    sessionId: 'sess-network',
    startedAt: '2024-01-01T12:00:00.000Z',
    actionCount: 0,
    ...overrides,
  };
}

function makeAction(seq: number, overrides: Partial<RecordingAction> = {}): RecordingAction {
  return {
    seq,
    ts: new Date('2024-01-01T12:00:00.000Z').getTime() + seq * 1000,
    tool: 'navigate',
    args: {},
    durationMs: 100,
    ok: true,
    summary: `action ${seq}`,
    ...overrides,
  };
}

function makeNetworkEntry(i: number): NetworkEntry {
  return {
    method: 'GET',
    url: `https://example.com/api/resource-${i}`,
    status: 200,
    durationMs: 50 + i,
  };
}

// ── No network field → no panel ───────────────────────────────────────────────

describe('generateHtmlReport — network panel absent', () => {
  it('omits network-panel when network field is undefined', () => {
    const html = generateHtmlReport(makeMetadata(), [makeAction(1)]);
    expect(html).not.toContain('network-panel');
    expect(html).not.toContain('<summary>Network');
  });

  it('omits network-panel when network is empty array', () => {
    const action = makeAction(1, { network: [] });
    const html = generateHtmlReport(makeMetadata(), [action]);
    expect(html).not.toContain('network-panel');
  });
});

// ── Network panel rendering ───────────────────────────────────────────────────

describe('generateHtmlReport — network panel present', () => {
  it('renders network-panel details element', () => {
    const network: NetworkEntry[] = [makeNetworkEntry(1)];
    const action = makeAction(1, { network });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('network-panel');
    expect(html).toContain('<details class="panel-details network-panel">');
  });

  it('shows method, url, status, and duration in a table row', () => {
    const network: NetworkEntry[] = [{
      method: 'POST',
      url: 'https://api.example.com/submit',
      status: 201,
      durationMs: 123,
    }];
    const action = makeAction(1, { network });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('POST');
    expect(html).toContain('https://api.example.com/submit');
    expect(html).toContain('201');
    expect(html).toContain('123ms');
  });

  it('renders dash for missing status', () => {
    const network: NetworkEntry[] = [{ method: 'GET', url: 'https://example.com/img.png' }];
    const action = makeAction(1, { network });
    const html = generateHtmlReport(makeMetadata(), [action]);

    // status column should show em-dash
    expect(html).toContain('—');
  });

  it('renders dash for missing durationMs', () => {
    const network: NetworkEntry[] = [{ method: 'GET', url: 'https://example.com/img.png', status: 200 }];
    const action = makeAction(1, { network });
    const html = generateHtmlReport(makeMetadata(), [action]);
    expect(html).toContain('—');
  });

  it('shows entry count in summary label', () => {
    const network: NetworkEntry[] = [makeNetworkEntry(1), makeNetworkEntry(2)];
    const action = makeAction(1, { network });
    const html = generateHtmlReport(makeMetadata(), [action]);
    expect(html).toContain('Network (2)');
  });

  it('renders table headers (Method, URL, Status, Duration)', () => {
    const action = makeAction(1, { network: [makeNetworkEntry(1)] });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('<th>Method</th>');
    expect(html).toContain('<th>URL</th>');
    expect(html).toContain('<th>Status</th>');
    expect(html).toContain('<th>Duration</th>');
  });

  it('escapes XSS in URL field', () => {
    const network: NetworkEntry[] = [{
      method: 'GET',
      url: 'https://evil.com/<script>alert(1)</script>',
      status: 200,
    }];
    const action = makeAction(1, { network });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders exactly 20 real entries plus truncation marker for 25 entries', () => {
    // The recorder already clips to 20 + marker; simulate post-clip state:
    // 20 real entries + 1 truncation marker with empty method
    const network: NetworkEntry[] = [];
    for (let i = 1; i <= 20; i++) {
      network.push(makeNetworkEntry(i));
    }
    // Append the truncation marker that the recorder would have added
    network.push({ method: '', url: '(+5 more — truncated)' });

    const action = makeAction(1, { network });
    const html = generateHtmlReport(makeMetadata(), [action]);

    // Truncation marker row spans all 4 columns
    expect(html).toContain('truncation-marker');
    expect(html).toContain('(+5 more — truncated)');
    // Count of 21 entries total (20 + marker)
    expect(html).toContain('Network (21)');
  });

  it('renders multiple network entries for one action', () => {
    const network: NetworkEntry[] = [
      { method: 'GET', url: 'https://example.com/a', status: 200, durationMs: 10 },
      { method: 'POST', url: 'https://example.com/b', status: 404, durationMs: 20 },
      { method: 'PUT', url: 'https://example.com/c', status: 500, durationMs: 30 },
    ];
    const action = makeAction(1, { network });
    const html = generateHtmlReport(makeMetadata(), [action]);

    expect(html).toContain('Network (3)');
    expect(html).toContain('https://example.com/a');
    expect(html).toContain('https://example.com/b');
    expect(html).toContain('https://example.com/c');
    expect(html).toContain('404');
    expect(html).toContain('500');
  });
});
