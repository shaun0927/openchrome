import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RunStore, hashRunArgs } from '../../src/run-harness/store';

describe('RunStore', () => {
  function tempStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-run-store-'));
    let now = 1000;
    let seq = 0;
    const store = new RunStore({ rootDir: dir, now: () => now++, idFactory: () => `id-${seq++}` });
    return { dir, store };
  }

  it('starts a run with running status and a run_started event', () => {
    const { store } = tempStore();
    const run = store.startRun({ run_id: 'run-test', session_id: 's1', tab_id: 't1' });
    expect(run.status).toBe('running');
    expect(run.events).toHaveLength(1);
    expect(run.events[0].kind).toBe('run_started');
    expect(run.session_id).toBe('s1');
  });

  it('records tool start and finish events with redacted stable arg hashes', () => {
    const { store } = tempStore();
    store.startRun({ run_id: 'run-tools' });
    store.appendToolStarted({ run_id: 'run-tools', tool: 'navigate', args: { url: 'https://example.com', password: 'secret' } });
    store.appendToolFinished({ run_id: 'run-tools', tool: 'navigate', ok: true, duration_ms: 12 });
    const run = store.getRun('run-tools')!;
    expect(run.events.map((e) => e.kind)).toEqual(['run_started', 'tool_call_started', 'tool_call_finished']);
    expect(run.events[1].args_hash).toBe(hashRunArgs({ password: 'different', url: 'https://example.com' }));
  });

  it('redacts persisted metadata and messages', () => {
    const { dir, store } = tempStore();
    store.startRun({
      run_id: 'run-redact',
      metadata: { token: 'abc123', nested: { note: 'password=hunter2 Bearer abc123' } },
    });
    store.appendToolFinished({
      run_id: 'run-redact',
      tool: 'read_page',
      ok: false,
      message: 'failed with api_key=secret123',
      metadata: { credential: 'plain', detail: 'secret=visible' },
    });
    store.finishRun('run-redact', {
      status: 'failed',
      message: 'token=final Bearer abc123',
      metadata: { nested: { password: 'hunter2' } },
    });

    const raw = fs.readFileSync(path.join(dir, 'run-redact.json'), 'utf8');
    expect(raw).not.toContain('abc123');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('secret123');
    expect(raw).not.toContain('plain');
    expect(raw).toContain('[REDACTED]');
  });

  it('finishes a run once and ignores later terminal writes', () => {
    const { store } = tempStore();
    store.startRun({ run_id: 'run-finish' });
    expect(store.finishRun('run-finish', { status: 'completed' })!.status).toBe('completed');
    expect(store.finishRun('run-finish', { status: 'failed' })!.status).toBe('completed');
  });

  it('persists records for a later store instance', () => {
    const { dir, store } = tempStore();
    store.startRun({ run_id: 'run-roundtrip' });
    store.appendToolFinished({ run_id: 'run-roundtrip', tool: 'read_page', ok: true });
    const next = new RunStore({ rootDir: dir });
    expect(next.getRun('run-roundtrip')?.events).toHaveLength(2);
  });

  it('rejects unsafe run ids', () => {
    const { store } = tempStore();
    expect(() => store.startRun({ run_id: '../escape' })).toThrow(/run_id/);
  });
});

describe('run budget guard', () => {
  it('detects same-tool retry budget without flagging batch-exempt tools', () => {
    const { store } = ((): ReturnType<typeof tempStoreForBudget> => tempStoreForBudget())();
    store.startRun({ run_id: 'run-budget-retry' });
    for (let i = 0; i < 3; i++) store.appendToolFinished({ run_id: 'run-budget-retry', tool: 'interact', ok: false, message: 'element not found' });
    for (let i = 0; i < 5; i++) store.appendToolFinished({ run_id: 'run-budget-retry', tool: 'batch_execute', ok: true });
    const { evaluateRunBudget } = require('../../src/run-harness/budget') as typeof import('../../src/run-harness/budget');
    const verdict = evaluateRunBudget(store.getRun('run-budget-retry')!, { max_same_tool_retries: 2 });
    expect(verdict.exceeded).toBe(true);
    expect(verdict.category).toBe('LLM_WANDERING');
  });

  it('detects observation-only and no-progress budgets', () => {
    const { store } = tempStoreForBudget();
    store.startRun({ run_id: 'run-budget-observe' });
    for (const tool of ['read_page', 'tabs_context', 'oc_progress_status']) store.appendToolFinished({ run_id: 'run-budget-observe', tool, ok: true, message: 'snapshot only' });
    const { evaluateRunBudget } = require('../../src/run-harness/budget') as typeof import('../../src/run-harness/budget');
    const verdict = evaluateRunBudget(store.getRun('run-budget-observe')!, { max_observation_only_calls: 2, max_no_progress_streak: 2 });
    expect(verdict.exceeded).toBe(true);
    expect(verdict.category).toBe('NO_PROGRESS');
  });

  it('detects wall-clock budget', () => {
    const { store } = tempStoreForBudget();
    store.startRun({ run_id: 'run-budget-wall' });
    const { evaluateRunBudget } = require('../../src/run-harness/budget') as typeof import('../../src/run-harness/budget');
    const verdict = evaluateRunBudget(store.getRun('run-budget-wall')!, { max_wall_ms: 10 }, 5000);
    expect(verdict.exceeded).toBe(true);
    expect(verdict.category).toBe('MAX_STEPS_EXCEEDED');
  });
});

function tempStoreForBudget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-run-budget-'));
  let now = 1000;
  let seq = 0;
  const store = new RunStore({ rootDir: dir, now: () => now++, idFactory: () => `budget-${seq++}` });
  return { dir, store };
}
describe('run evidence auto-capture', () => {
  it('captures evidence metadata for failed tool calls and redacts secrets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-run-evidence-store-'));
    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-run-evidence-out-'));
    let now = 1000;
    let seq = 0;
    const store = new RunStore({ rootDir: dir, evidenceRootDir: evidenceDir, now: () => now++, idFactory: () => `ev-${seq++}` });
    store.startRun({ run_id: 'run-evidence', session_id: 's1', tab_id: 't1' });
    store.appendToolFinished({
      run_id: 'run-evidence',
      session_id: 's1',
      tab_id: 't1',
      tool: 'interact',
      ok: false,
      message: 'selector not found password=hunter2',
      metadata: { url: 'https://example.test', title: 'Example', failureCategory: 'ELEMENT_NOT_FOUND', token: 'abc123' },
    });

    const run = store.getRun('run-evidence')!;
    const evidenceEvent = run.events.find((event) => event.kind === 'evidence')!;
    expect(evidenceEvent).toBeTruthy();
    const evidencePath = (evidenceEvent.metadata as any).path as string;
    const raw = fs.readFileSync(evidencePath, 'utf8');
    expect(raw).toContain('ELEMENT_NOT_FOUND');
    expect(raw).toContain('disabled by run evidence safe mode');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('abc123');
  });

  it('captures evidence for stuck progress metadata without network or console slices', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-run-stuck-store-'));
    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-run-stuck-evidence-'));
    const store = new RunStore({ rootDir: dir, evidenceRootDir: evidenceDir, now: () => 2000, idFactory: () => 'stuck-id' });
    store.startRun({ run_id: 'run-stuck' });
    store.appendToolFinished({ run_id: 'run-stuck', tool: 'read_page', ok: true, metadata: { progress: { status: 'stuck' } } });
    const evidenceEvent = store.getRun('run-stuck')!.events.find((event) => event.kind === 'evidence')!;
    const parsed = JSON.parse(fs.readFileSync((evidenceEvent.metadata as any).path, 'utf8'));
    expect(parsed.trigger).toBe('stuck');
    expect(parsed.metadata.network.included).toBe(false);
    expect(parsed.metadata.console.included).toBe(false);
  });
});

describe('run long-task events and retention', () => {
  it('appends pollable progress and partial-result events', () => {
    const { store } = tempStoreForBudget();
    store.startRun({ run_id: 'run-long' });
    store.appendRunEvent({
      run_id: 'run-long',
      kind: 'progress',
      tool: 'crawl',
      message: 'long task started',
      metadata: { stage: 'started', token: 'abc123' },
    });
    store.appendRunEvent({
      run_id: 'run-long',
      kind: 'partial_result',
      tool: 'crawl',
      ok: true,
      metadata: { collected: 2 },
    });

    const run = store.getRun('run-long')!;
    expect(run.events.map((event) => event.kind)).toEqual([
      'run_started',
      'progress',
      'partial_result',
    ]);
    expect(JSON.stringify(run)).not.toContain('abc123');
  });

  it('retains active runs while pruning older terminal run records', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-run-retain-'));
    let now = 1000;
    let seq = 0;
    const store = new RunStore({
      rootDir: dir,
      maxRecords: 2,
      now: () => now++,
      idFactory: () => `retain-${seq++}`,
    });
    store.startRun({ run_id: 'run-old-terminal' });
    store.finishRun('run-old-terminal', { status: 'completed' });
    store.startRun({ run_id: 'run-active' });
    store.startRun({ run_id: 'run-new-terminal' });
    store.finishRun('run-new-terminal', { status: 'failed' });

    expect(store.getRun('run-active')).not.toBeNull();
    expect(store.getRun('run-new-terminal')).not.toBeNull();
    expect(store.getRun('run-old-terminal')).toBeNull();
  });
});
