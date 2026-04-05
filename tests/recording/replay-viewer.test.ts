/**
 * Tests for ReplayViewer and generateHtmlReport.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RecordingStore } from '../../src/recording/recording-store';
import { RecordingAction, RecordingMetadata } from '../../src/recording/types';
import { ReplayViewer } from '../../src/recording/replay-viewer';
import { generateHtmlReport } from '../../src/recording/html-template';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `replay-viewer-test-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

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
    durationMs: 150 + seq * 10,
    ok: true,
    summary: `Navigated to https://example${seq}.com`,
    url: `https://example${seq}.com`,
    ...overrides,
  };
}

// ── generateHtmlReport ────────────────────────────────────────────────────────

describe('generateHtmlReport', () => {
  it('returns a valid HTML5 document', () => {
    const metadata = makeMetadata({ actionCount: 2 });
    const actions = [makeAction(1), makeAction(2)];
    const html = generateHtmlReport(metadata, actions);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
  });

  it('embeds recording metadata in the header', () => {
    const metadata = makeMetadata({
      id: 'rec-20240101-120000-abcd',
      sessionId: 'sess-xyz',
      label: 'My Test Recording',
      profile: 'default',
      actionCount: 3,
    });
    const html = generateHtmlReport(metadata, []);

    expect(html).toContain('rec-20240101-120000-abcd');
    expect(html).toContain('sess-xyz');
    expect(html).toContain('My Test Recording');
    expect(html).toContain('default');
  });

  it('renders action cards with correct tool names', () => {
    const actions = [
      makeAction(1, { tool: 'navigate' }),
      makeAction(2, { tool: 'interact' }),
      makeAction(3, { tool: 'read_page' }),
    ];
    const html = generateHtmlReport(makeMetadata(), actions);

    expect(html).toContain('navigate');
    expect(html).toContain('interact');
    expect(html).toContain('read_page');
  });

  it('applies correct badge classes for tool categories', () => {
    const actions = [
      makeAction(1, { tool: 'navigate' }),
      makeAction(2, { tool: 'interact' }),
      makeAction(3, { tool: 'read_page' }),
      makeAction(4, { tool: 'custom_tool' }),
    ];
    const html = generateHtmlReport(makeMetadata(), actions);

    expect(html).toContain('badge-navigation');
    expect(html).toContain('badge-interaction');
    expect(html).toContain('badge-data');
    expect(html).toContain('badge-default');
  });

  it('shows failure indicator for failed actions', () => {
    const actions = [
      makeAction(1, { ok: false, error: 'Element not found' }),
    ];
    const html = generateHtmlReport(makeMetadata(), actions);

    expect(html).toContain('data-ok="false"');
    expect(html).toContain('Element not found');
    expect(html).toContain('error-msg');
  });

  it('shows success indicator for successful actions', () => {
    const actions = [makeAction(1, { ok: true })];
    const html = generateHtmlReport(makeMetadata(), actions);

    expect(html).toContain('data-ok="true"');
    expect(html).toContain('action-card ok');
  });

  it('renders summary statistics', () => {
    const actions = [
      makeAction(1, { ok: true }),
      makeAction(2, { ok: true }),
      makeAction(3, { ok: false }),
    ];
    const html = generateHtmlReport(makeMetadata(), actions);

    // stats bar should have counts
    expect(html).toContain('Total Actions');
    expect(html).toContain('Succeeded');
    expect(html).toContain('Failed');
    expect(html).toContain('Success Rate');
  });

  it('handles empty recording gracefully', () => {
    const html = generateHtmlReport(makeMetadata({ actionCount: 0 }), []);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('No actions recorded');
    expect(html).toContain('Total Actions');
  });

  it('escapes HTML in tool args to prevent XSS', () => {
    const actions = [
      makeAction(1, {
        tool: 'navigate',
        args: { url: 'https://example.com/<script>alert(1)</script>' },
        summary: '<b>bold summary</b>',
      }),
    ];
    const html = generateHtmlReport(makeMetadata(), actions);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<b>bold summary</b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('embeds screenshots as base64 data URIs', () => {
    const actions = [
      makeAction(1, {
        screenshotBefore: 'screenshot-1-before.webp',
        screenshotAfter: 'screenshot-1-after.webp',
      }),
    ];
    const fakeB64 = Buffer.from('fake-image-data').toString('base64');
    const screenshots = new Map<string, string>([
      ['screenshot-1-before.webp', `data:image/webp;base64,${fakeB64}`],
      ['screenshot-1-after.webp', `data:image/webp;base64,${fakeB64}`],
    ]);

    const html = generateHtmlReport(makeMetadata(), actions, screenshots);

    expect(html).toContain(`data:image/webp;base64,${fakeB64}`);
    expect(html).toContain('Before');
    expect(html).toContain('After');
    expect(html).toContain('<img class="screenshot"');
  });

  it('omits screenshot section when no screenshots provided', () => {
    const actions = [makeAction(1)]; // no screenshotBefore/After
    const html = generateHtmlReport(makeMetadata(), actions, new Map());

    expect(html).not.toContain('<img class="screenshot"');
  });

  it('includes filter controls in the HTML', () => {
    const actions = [makeAction(1, { tool: 'navigate' })];
    const html = generateHtmlReport(makeMetadata(), actions);

    expect(html).toContain('filter-tool');
    expect(html).toContain('filter-failures');
    expect(html).toContain('filter-search');
  });

  it('populates tool filter options from actions', () => {
    const actions = [
      makeAction(1, { tool: 'navigate' }),
      makeAction(2, { tool: 'interact' }),
    ];
    const html = generateHtmlReport(makeMetadata(), actions);

    // tool options should include navigate and interact
    expect(html).toContain('<option value="interact">');
    expect(html).toContain('<option value="navigate">');
  });

  it('includes inline JavaScript for filtering', () => {
    const html = generateHtmlReport(makeMetadata(), []);
    expect(html).toContain('<script>');
    expect(html).toContain('applyFilters');
    expect(html).toContain('filter-tool');
  });

  it('includes keyboard navigation JavaScript', () => {
    const html = generateHtmlReport(makeMetadata(), []);
    expect(html).toContain('ArrowDown');
    expect(html).toContain('ArrowUp');
    expect(html).toContain('scrollIntoView');
  });

  it('includes inline CSS with dark theme colors', () => {
    const html = generateHtmlReport(makeMetadata(), []);
    expect(html).toContain('<style>');
    expect(html).toContain('#1a1a2e'); // dark background color
    expect(html).toContain('--bg:');
  });

  it('renders collapsible args sections using details element', () => {
    const actions = [makeAction(1, { args: { url: 'https://example.com', timeout: 5000 } })];
    const html = generateHtmlReport(makeMetadata(), actions);

    expect(html).toContain('<details class="args-details">');
    expect(html).toContain('<summary>Arguments</summary>');
  });

  it('handles action with no optional fields', () => {
    const minimal: RecordingAction = {
      seq: 1,
      ts: Date.now(),
      tool: 'navigate',
      args: {},
      durationMs: 100,
      ok: true,
      summary: 'navigated',
    };
    const html = generateHtmlReport(makeMetadata(), [minimal]);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('navigated');
  });

  it('renders recording with label and profile in metadata', () => {
    const metadata = makeMetadata({ label: 'Smoke Test Run', profile: 'incognito' });
    const html = generateHtmlReport(metadata, []);
    expect(html).toContain('Smoke Test Run');
    expect(html).toContain('incognito');
  });
});

// ── ReplayViewer.formatTerminalReplay ─────────────────────────────────────────

describe('ReplayViewer.formatTerminalReplay', () => {
  let viewer: ReplayViewer;
  let tmpDir: string;
  let store: RecordingStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new RecordingStore(tmpDir);
    viewer = new ReplayViewer(store, tmpDir);
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('includes recording header information', () => {
    const metadata = makeMetadata({ id: 'rec-test-id', sessionId: 'sess-test' });
    const output = viewer.formatTerminalReplay(metadata, []);
    expect(output).toContain('rec-test-id');
    expect(output).toContain('sess-test');
    expect(output).toContain('2024-01-01T12:00:00.000Z');
  });

  it('formats each action with timestamp, duration, tool, and summary', () => {
    const actions = [makeAction(1, { tool: 'navigate', summary: 'Navigated to example.com', durationMs: 250 })];
    const output = viewer.formatTerminalReplay(makeMetadata(), actions);

    expect(output).toContain('navigate');
    expect(output).toContain('Navigated to example.com');
    expect(output).toContain('250ms');
    expect(output).toContain('OK');
  });

  it('marks failed actions with FAIL', () => {
    const actions = [makeAction(1, { ok: false, summary: 'Failed action' })];
    const output = viewer.formatTerminalReplay(makeMetadata(), actions);
    expect(output).toContain('FAIL');
  });

  it('shows error message for failed actions', () => {
    const actions = [makeAction(1, { ok: false, error: 'Timeout exceeded' })];
    const output = viewer.formatTerminalReplay(makeMetadata(), actions);
    expect(output).toContain('Timeout exceeded');
  });

  it('includes summary statistics at the end', () => {
    const actions = [
      makeAction(1, { ok: true }),
      makeAction(2, { ok: true }),
      makeAction(3, { ok: false }),
    ];
    const output = viewer.formatTerminalReplay(makeMetadata(), actions);

    expect(output).toContain('Total actions');
    expect(output).toContain('Succeeded');
    expect(output).toContain('Failed');
    expect(output).toContain('Success rate');
  });

  it('handles empty recording gracefully', () => {
    const output = viewer.formatTerminalReplay(makeMetadata({ actionCount: 0 }), []);
    expect(output).toContain('no actions recorded');
    expect(output).toContain('Recording Replay');
  });

  it('highlights milestone actions (every 10th or failures)', () => {
    const actions = Array.from({ length: 10 }, (_, i) => makeAction(i + 1));
    const output = viewer.formatTerminalReplay(makeMetadata(), actions);
    // seq=10 is a milestone — lines start with '>'
    const lines = output.split('\n');
    const milestoneLine = lines.find(l => l.startsWith('>') && l.includes('#  10'));
    expect(milestoneLine).toBeDefined();
  });

  it('includes label if present', () => {
    const metadata = makeMetadata({ label: 'Regression Suite' });
    const output = viewer.formatTerminalReplay(metadata, []);
    expect(output).toContain('Regression Suite');
  });

  it('formats duration in seconds for long-running actions', () => {
    const actions = [makeAction(1, { durationMs: 3500 })];
    const output = viewer.formatTerminalReplay(makeMetadata(), actions);
    expect(output).toContain('3.50s');
  });
});

// ── ReplayViewer.generateReport (disk I/O) ────────────────────────────────────

describe('ReplayViewer.generateReport', () => {
  let tmpDir: string;
  let store: RecordingStore;
  let viewer: ReplayViewer;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new RecordingStore(tmpDir);
    await store.init();
    viewer = new ReplayViewer(store, tmpDir);
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('generates report.html file in the recording directory', async () => {
    const metadata = makeMetadata({ actionCount: 1 });
    await store.createRecording(metadata);
    store.appendAction(metadata.id, makeAction(1));

    const reportPath = await viewer.generateReport(metadata.id);

    expect(reportPath).toContain('report.html');
    expect(fs.existsSync(reportPath)).toBe(true);
  });

  it('written HTML contains expected content', async () => {
    const metadata = makeMetadata({ actionCount: 2 });
    await store.createRecording(metadata);
    store.appendAction(metadata.id, makeAction(1, { tool: 'navigate' }));
    store.appendAction(metadata.id, makeAction(2, { tool: 'interact' }));

    const reportPath = await viewer.generateReport(metadata.id);
    const html = fs.readFileSync(reportPath, 'utf-8');

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain(metadata.id);
    expect(html).toContain('navigate');
    expect(html).toContain('interact');
  });

  it('throws if recording does not exist', async () => {
    await expect(viewer.generateReport('rec-20240101-120000-miss')).rejects.toThrow(
      'Recording not found: rec-20240101-120000-miss',
    );
  });

  it('embeds screenshots when present', async () => {
    const metadata = makeMetadata({ actionCount: 1 });
    await store.createRecording(metadata);

    const screenshotBuf = Buffer.from('fake-png-data');
    await store.saveScreenshot(metadata.id, 'screenshot-1-before.png', screenshotBuf);

    store.appendAction(
      metadata.id,
      makeAction(1, { screenshotBefore: 'screenshot-1-before.png' }),
    );

    const reportPath = await viewer.generateReport(metadata.id);
    const html = fs.readFileSync(reportPath, 'utf-8');

    const expectedB64 = screenshotBuf.toString('base64');
    expect(html).toContain(expectedB64);
    expect(html).toContain('data:image/png;base64,');
  });

  it('handles recording with all failed actions', async () => {
    const metadata = makeMetadata({ actionCount: 2 });
    await store.createRecording(metadata);
    store.appendAction(metadata.id, makeAction(1, { ok: false, error: 'Network error' }));
    store.appendAction(metadata.id, makeAction(2, { ok: false, error: 'Timeout' }));

    const reportPath = await viewer.generateReport(metadata.id);
    const html = fs.readFileSync(reportPath, 'utf-8');

    expect(html).toContain('Network error');
    expect(html).toContain('Timeout');
    expect(html).toContain('0%'); // 0% success rate
  });
});

// ── ReplayViewer.generateTerminalReplay (disk I/O) ───────────────────────────

describe('ReplayViewer.generateTerminalReplay', () => {
  let tmpDir: string;
  let store: RecordingStore;
  let viewer: ReplayViewer;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new RecordingStore(tmpDir);
    await store.init();
    viewer = new ReplayViewer(store, tmpDir);
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('returns terminal timeline string for an existing recording', async () => {
    const metadata = makeMetadata({ actionCount: 1 });
    await store.createRecording(metadata);
    store.appendAction(metadata.id, makeAction(1, { tool: 'navigate', summary: 'opened page' }));

    const output = await viewer.generateTerminalReplay(metadata.id);

    expect(typeof output).toBe('string');
    expect(output).toContain(metadata.id);
    expect(output).toContain('navigate');
    expect(output).toContain('opened page');
  });

  it('throws if recording does not exist', async () => {
    await expect(viewer.generateTerminalReplay('rec-20240101-120000-nope')).rejects.toThrow(
      'Recording not found: rec-20240101-120000-nope',
    );
  });
});
