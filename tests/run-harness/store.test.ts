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
