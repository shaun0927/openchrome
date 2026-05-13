import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TaskStore, buildTaskEvidenceDigest, computeTaskId } from '../../../src/core/task-ledger';
import type { TaskMeta } from '../../../src/core/task-ledger';
import { registerOcTaskGetTool } from '../../../src/tools/oc-task-get';
import { setTaskStoreForTests } from '../../../src/tools/oc-task-start';
import type { MCPResult, ToolHandler } from '../../../src/types/mcp';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-task-digest-'));
}

function metaFor(kind = 'navigate', args: Record<string, unknown> = {}): TaskMeta {
  const created = 1234;
  return {
    task_id: computeTaskId(kind, args, created),
    kind,
    status: 'COMPLETED',
    pid: process.pid,
    created_at: created,
    started_at: created + 1,
    ended_at: created + 10,
    args_summary: args,
    owner: { session_id: 'sess-1' },
  };
}

describe('Task evidence digest', () => {
  let root: string;
  let store: TaskStore;

  beforeEach(() => {
    root = tempRoot();
    store = new TaskStore({ rootDir: root });
    setTaskStoreForTests(store);
  });

  afterEach(() => {
    setTaskStoreForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('summarizes navigation, observation, interaction, assertion, failure, and unknown events deterministically', async () => {
    const meta = metaFor('navigate', { objective: 'Buy test item', url: 'https://example.test/start', tabId: 'tab-a' });
    await store.create(meta);
    await store.writeResult(meta.task_id, {
      url: 'https://example.test/done',
      title: 'Done',
      tabId: 'tab-a',
      assertions: [{ contract_id: 'done-visible', passed: true, summary: 'Done text visible' }],
      budget_status: 'within budget',
    });
    store.appendEvent(meta.task_id, { ts: 1, kind: 'started' });
    store.appendEvent(meta.task_id, { ts: 2, kind: 'progress', data: { tool: 'navigate', summary: 'navigated to /start' } });
    store.appendEvent(meta.task_id, { ts: 3, kind: 'progress', data: { tool: 'read_page', summary: 'observed checkout page' } });
    store.appendEvent(meta.task_id, { ts: 4, kind: 'progress', data: { tool: 'interact', summary: 'clicked submit button' } });
    store.appendEvent(meta.task_id, { ts: 5, kind: 'progress', data: { tool: 'oc_assert', summary: 'contract passed', category: 'assertion' } });
    store.appendEvent(meta.task_id, { ts: 6, kind: 'failed', data: { tool: 'interact', error: 'stale ref for @e1' } });
    store.appendEvent(meta.task_id, { ts: 7, kind: 'progress', data: { tool: 'custom_tool', summary: 'custom checkpoint' } });

    const a = buildTaskEvidenceDigest(store, meta.task_id);
    const b = buildTaskEvidenceDigest(store, meta.task_id);

    expect(a).toEqual(b);
    expect(a?.objective).toBe('Buy test item');
    expect(a?.phase).toBe('completed');
    expect(a?.page_state).toMatchObject({ url: 'https://example.test/done', title: 'Done', tabId: 'tab-a' });
    expect(a?.recent_meaningful_events.map(e => e.category)).toEqual([
      'navigation', 'navigation', 'observation', 'interaction', 'assertion', 'interaction', 'checkpoint',
    ]);
    expect(a?.latest_assertions?.[0]).toEqual({ contract_id: 'done-visible', passed: true, summary: 'Done text visible' });
    expect(a?.latest_failures?.[0].normalized_error).toContain('stale ref');
    expect(a?.latest_failures?.[0].suggested_recovery).toContain('reacquire');
    expect(a?.budget_status).toBe('within budget');
    expect(a?.recent_meaningful_events.every(e => e.evidence_ref?.startsWith(`task://${meta.task_id}/events/`))).toBe(true);
  });

  test('uses camelCase and structured page-state fallbacks, including nested tab id', async () => {
    const meta = metaFor('read_page', { objective: 'Inspect page' });
    await store.create(meta);

    await store.writeResult(meta.task_id, {
      pageState: {
        url: 'https://example.test/camel',
        title: 'Camel',
        tabId: 'tab-camel',
        capturedAt: 2222,
      },
    });
    expect(buildTaskEvidenceDigest(store, meta.task_id)?.page_state).toMatchObject({
      url: 'https://example.test/camel',
      title: 'Camel',
      tabId: 'tab-camel',
      capturedAt: 2222,
    });

    await store.writeResult(meta.task_id, {
      structuredContent: {
        url: 'https://example.test/structured',
        title: 'Structured',
        tab_id: 'tab-structured',
      },
    });
    expect(buildTaskEvidenceDigest(store, meta.task_id)?.page_state).toMatchObject({
      url: 'https://example.test/structured',
      title: 'Structured',
      tabId: 'tab-structured',
    });
  });

  test('bounds summaries and redacts credential-bearing fields', async () => {
    const meta = metaFor('read_page', { objective: 'Inspect token=super-secret-value', url: 'https://example.test' });
    await store.create(meta);
    store.appendEvent(meta.task_id, {
      ts: 1,
      kind: 'progress',
      data: {
        tool: 'read_page',
        summary: `authorization: Bearer abc.def.ghi ${'x'.repeat(500)}`,
      },
    });

    const digest = buildTaskEvidenceDigest(store, meta.task_id, { maxSummaryChars: 80 });
    const serialized = JSON.stringify(digest);

    expect(serialized).not.toContain('abc.def.ghi');
    expect(serialized).not.toContain('super-secret-value');
    expect(digest?.recent_meaningful_events[0].summary.length).toBeLessThanOrEqual(80);
  });

  test('oc_task_get returns digest only when includeDigest is requested', async () => {
    const meta = metaFor('navigate', { objective: 'Open page', url: 'https://example.test' });
    await store.create(meta);
    store.appendEvent(meta.task_id, { ts: 1, kind: 'completed', data: { tool: 'navigate', summary: 'done' } });

    const handlers = new Map<string, (sessionId: string, args: Record<string, unknown>) => Promise<MCPResult>>();
    registerOcTaskGetTool({
      registerTool: (name: string, handler: ToolHandler) => handlers.set(name, handler),
    } as never);
    const get = handlers.get('oc_task_get')!;

    const plain = await get('sess-1', { task_id: meta.task_id });
    expect(plain.digest).toBeUndefined();

    const withDigest = await get('sess-1', { task_id: meta.task_id, includeDigest: true });
    expect(withDigest.digest).toMatchObject({ task_id: meta.task_id, objective: 'Open page' });
  });
});
