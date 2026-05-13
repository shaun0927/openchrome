/**
 * Tool-level integration: oc_task_start wraps a fake inner tool and
 * the result is observable via oc_task_get / oc_task_wait. Exercises
 * the test-seam exposed by oc-task-start so we don't need a full
 * MCPServer instance.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TaskStore } from '../../../src/core/task-ledger';
import {
  __test__,
  getTaskStore,
  setTaskStoreForTests,
} from '../../../src/tools/oc-task-start';
import { __test__ as taskGetTest } from '../../../src/tools/oc-task-get';
import type { MCPResult, ToolHandler } from '../../../src/types/mcp';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-tasks-tools-'));
}

describe('oc_task_start handler — happy path', () => {
  let root: string;

  beforeEach(() => {
    root = tempRoot();
    setTaskStoreForTests(new TaskStore({ rootDir: root }));
  });

  afterEach(() => {
    setTaskStoreForTests(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('launches inner tool, persists result, terminal status is COMPLETED', async () => {
    let invocations = 0;
    const innerTool: ToolHandler = async (_sid, args): Promise<MCPResult> => {
      invocations++;
      return {
        content: [{ type: 'text', text: `ran with url=${args.url}` }],
        url: args.url,
      };
    };
    const handler = __test__.makeHandler({
      resolveTool: (name) => (name === 'fake_inner' ? innerTool : null),
    });

    const out = await handler('sess-1', { kind: 'fake_inner', args: { url: 'https://example.com' } });
    expect(out.task_id).toMatch(/^[0-9a-f]{16}$/);
    expect(out.status).toBe('PENDING');

    // Allow the background runner to finish.
    const store = getTaskStore();
    const taskId = out.task_id as string;
    for (let i = 0; i < 200; i++) {
      const meta = store.readMetaSync(taskId);
      if (meta && (meta.status === 'COMPLETED' || meta.status === 'FAILED')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const finalMeta = store.readMetaSync(taskId);
    expect(finalMeta?.status).toBe('COMPLETED');
    expect(invocations).toBe(1);
    const result = store.readResultSync(taskId) as { url: string };
    expect(result.url).toBe('https://example.com');
  });



  test('creates a host-driven browser_task envelope when kind is omitted', async () => {
    const handler = __test__.makeHandler({ resolveTool: () => null });
    const out = await handler('sess-1', {
      objective: 'exercise budgets',
      phase: 'explore',
      policy: { maxObservationStreak: 3 },
    });
    expect(out.task_id).toMatch(/^[0-9a-f]{16}$/);
    expect(out.status).toBe('RUNNING');
    const meta = getTaskStore().readMetaSync(out.task_id as string);
    expect(meta?.kind).toBe('browser_task');
    expect(meta?.objective).toBe('exercise budgets');
    expect(meta?.policy?.maxObservationStreak).toBe(3);
    expect(meta?.budget_status).toBe('ok');
  });

  test('returns isError when tool name is not registered', async () => {
    const handler = __test__.makeHandler({ resolveTool: () => null });
    const out = await handler('sess-1', { kind: 'nope', args: {} });
    expect(out.isError).toBe(true);
  });

  test('omitted kind starts an envelope instead of launching an inner tool', async () => {
    const handler = __test__.makeHandler({ resolveTool: () => null });
    const out = await handler('sess-1', { args: {} });
    expect(out.isError).not.toBe(true);
    expect(out.kind).toBe('browser_task');
  });

  test('oc_task_get accepts taskId alias through schema and handler', async () => {
    const handler = __test__.makeHandler({ resolveTool: () => null });
    const started = await handler('sess-1', {
      objective: 'poll through alias',
      phase: 'explore',
    });

    expect(taskGetTest.definition.inputSchema.required).toBeUndefined();

    const fetched = await taskGetTest.handler('sess-1', {
      taskId: started.task_id,
    });

    expect(fetched.isError).not.toBe(true);
    expect(fetched.meta).toMatchObject({ task_id: started.task_id, objective: 'poll through alias' });
  });
});
