/**
 * Tests for oc_assert recorder wiring (issue #852).
 *
 * Verifies the behaviour matrix:
 *  - No active recorder → oc_assert returns normal response, no crash.
 *  - Active recorder, >= 1 prior action → verdict appended to most-recent action.
 *  - Active recorder, zero prior actions → no-op (no synthetic action created).
 *
 * We drive oc_assert via server.getToolHandler() following the pattern used in
 * tests/tools/recording.test.ts.  A real ActionRecorder backed by a tmpdir
 * store is registered into the session registry so the handler can find it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MCPServer } from '../../src/mcp-server';
import {
  ActionRecorder,
  registerSessionRecorder,
  unregisterSessionRecorder,
} from '../../src/recording/action-recorder';
import { RecordingStore } from '../../src/recording/recording-store';
import { registerOcAssertTool } from '../../src/tools/oc-assert';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `oc-assert-wiring-${Math.random().toString(36).slice(2)}`);
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

/** Minimal snapshot that makes a url assertion decidable. */
function urlEvidence(url: string) {
  return { snapshot: { url } };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let server: MCPServer;
let handler: (sessionId: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

beforeAll(() => {
  server = new MCPServer();
  registerOcAssertTool(server);
  const h = server.getToolHandler('oc_assert');
  if (!h) throw new Error('oc_assert tool handler not registered');
  handler = h as typeof handler;
});

// ── No active recorder ────────────────────────────────────────────────────────

describe('oc_assert wiring — no active recorder', () => {
  const SESSION = 'sess-no-recorder-852';

  it('returns a verdict without crashing when no recorder is registered', async () => {
    const result = await handler(SESSION, {
      contract: { kind: 'url', pattern: 'example.com' },
      evidence: urlEvidence('https://example.com/'),
    });

    const text = (result.content as Array<{ text: string }>)[0].text;
    const output = JSON.parse(text) as { verdict: string };
    expect(['pass', 'fail', 'inconclusive']).toContain(output.verdict);
  });

  it('verdict is pass when url matches and no recorder is active', async () => {
    const result = await handler(SESSION, {
      contract: { kind: 'url', pattern: 'example.com' },
      evidence: urlEvidence('https://example.com/page'),
    });

    const text = (result.content as Array<{ text: string }>)[0].text;
    const output = JSON.parse(text) as { verdict: string };
    expect(output.verdict).toBe('pass');
  });
});

// ── Active recorder, zero prior actions ──────────────────────────────────────

describe('oc_assert wiring — active recorder, zero prior actions', () => {
  let dir: string;
  let store: RecordingStore;
  let recorder: ActionRecorder;
  const SESSION = 'sess-zero-actions-852';

  beforeEach(async () => {
    dir = makeTmpDir();
    store = new RecordingStore(dir);
    recorder = new ActionRecorder(store, { captureScreenshots: false });
    await recorder.start(SESSION);
    registerSessionRecorder(SESSION, recorder);
  });

  afterEach(async () => {
    if (recorder.isRecording) await recorder.stop();
    unregisterSessionRecorder(SESSION);
    cleanupDir(dir);
  });

  it('returns a verdict normally when no actions have been recorded yet', async () => {
    const result = await handler(SESSION, {
      contract: { kind: 'url', pattern: 'example.com' },
      evidence: urlEvidence('https://example.com/'),
    });

    const text = (result.content as Array<{ text: string }>)[0].text;
    const output = JSON.parse(text) as { verdict: string };
    expect(output.verdict).toBe('pass');
  });

  it('does not create any recording actions for the assertion itself', async () => {
    await handler(SESSION, {
      contract: { kind: 'url', pattern: 'example.com' },
      evidence: urlEvidence('https://example.com/'),
    });

    // Flush any pending async writes from the fire-and-forget appendContractResult
    await new Promise((r) => setTimeout(r, 100));

    const id = recorder.activeRecordingId!;
    const actions = store.readActions(id);
    expect(actions).toHaveLength(0);
  });
});

// ── Active recorder, >= 1 prior action (pass) ────────────────────────────────

describe('oc_assert wiring — active recorder, prior action exists (pass verdict)', () => {
  let dir: string;
  let store: RecordingStore;
  let recorder: ActionRecorder;
  const SESSION = 'sess-with-actions-pass-852';

  beforeEach(async () => {
    dir = makeTmpDir();
    store = new RecordingStore(dir);
    recorder = new ActionRecorder(store, { captureScreenshots: false });
    await recorder.start(SESSION);
    registerSessionRecorder(SESSION, recorder);
    await recorder.recordAction('navigate', { url: 'https://example.com' }, 150, true);
  });

  afterEach(async () => {
    if (recorder.isRecording) await recorder.stop();
    unregisterSessionRecorder(SESSION);
    cleanupDir(dir);
  });

  it('appends pass verdict to the most recent action contractResults', async () => {
    await handler(SESSION, {
      contract: { kind: 'url', pattern: 'example.com' },
      evidence: urlEvidence('https://example.com/page'),
    });

    // Give the fire-and-forget promise time to complete
    await new Promise((r) => setTimeout(r, 200));

    const id = recorder.activeRecordingId!;
    const actions = store.readActions(id);
    expect(actions).toHaveLength(1);
    expect(actions[0].contractResults).toBeDefined();
    expect(actions[0].contractResults!).toHaveLength(1);
    expect(actions[0].contractResults![0].verdict).toBe('pass');
  });

  it('stores the assertion inline in the contractResult entry', async () => {
    const assertion = { kind: 'url', pattern: 'example.com' };
    await handler(SESSION, {
      contract: assertion,
      evidence: urlEvidence('https://example.com/'),
    });

    await new Promise((r) => setTimeout(r, 200));

    const id = recorder.activeRecordingId!;
    const actions = store.readActions(id);
    const cr = actions[0].contractResults![0];
    expect(cr.assertion).toEqual(assertion);
  });

  it('appends to last action, not first, when multiple actions exist', async () => {
    // Record a second action
    await recorder.recordAction('read_page', {}, 50, true);

    await handler(SESSION, {
      contract: { kind: 'url', pattern: 'example.com' },
      evidence: urlEvidence('https://example.com/'),
    });

    await new Promise((r) => setTimeout(r, 200));

    const id = recorder.activeRecordingId!;
    const actions = store.readActions(id);
    // first action has no contractResults
    expect(actions[0].contractResults).toBeUndefined();
    // second action (last) has the appended result
    expect(actions[1].contractResults).toHaveLength(1);
    expect(actions[1].contractResults![0].verdict).toBe('pass');
  });
});

// ── Active recorder, >= 1 prior action (fail) ────────────────────────────────

describe('oc_assert wiring — active recorder, prior action exists (fail verdict)', () => {
  let dir: string;
  let store: RecordingStore;
  let recorder: ActionRecorder;
  const SESSION = 'sess-with-actions-fail-852';

  beforeEach(async () => {
    dir = makeTmpDir();
    store = new RecordingStore(dir);
    recorder = new ActionRecorder(store, { captureScreenshots: false });
    await recorder.start(SESSION);
    registerSessionRecorder(SESSION, recorder);
    await recorder.recordAction('navigate', { url: 'https://example.com' }, 150, true);
  });

  afterEach(async () => {
    if (recorder.isRecording) await recorder.stop();
    unregisterSessionRecorder(SESSION);
    cleanupDir(dir);
  });

  it('appends fail verdict to the most recent action when assertion fails', async () => {
    // Pattern that will NOT match the url
    await handler(SESSION, {
      contract: { kind: 'url', pattern: 'not-present-xyz-852' },
      evidence: urlEvidence('https://example.com/page'),
    });

    await new Promise((r) => setTimeout(r, 200));

    const id = recorder.activeRecordingId!;
    const actions = store.readActions(id);
    expect(actions[0].contractResults).toBeDefined();
    expect(actions[0].contractResults![0].verdict).toBe('fail');
  });
});
