import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPServer } from '../../src/mcp-server';
import { registerAllTools } from '../../src/tools';

describe('Bulk progress tool registration', () => {
  it('registers bulk progress tools', () => {
    const server = new MCPServer(undefined as any);
    registerAllTools(server);
    const names = server.getToolNames();
    expect(names).toEqual(expect.arrayContaining([
      'oc_bulk_progress_start',
      'oc_bulk_progress_update',
      'oc_bulk_progress_check',
    ]));
  });
});

describe('TaskRun bulk completion guard tool integration', () => {
  let dir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-bulk-tools-'));
    previousHome = process.env.OPENCHROME_HOME;
    process.env.OPENCHROME_HOME = dir;
    jest.resetModules();
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.OPENCHROME_HOME;
    } else {
      process.env.OPENCHROME_HOME = previousHome;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    jest.resetModules();
  });

  it('rejects premature oc_task_run_complete and allows completion after progress is recorded', async () => {
    const { taskRunToolHandlers } = require('../../src/tools/task-run') as typeof import('../../src/tools/task-run');
    const { bulkProgressToolHandlers } = require('../../src/tools/bulk-progress') as typeof import('../../src/tools/bulk-progress');

    const started = await taskRunToolHandlers.startHandler('default', { goal: 'Visit three URLs' }, undefined as any);
    const runId = (started.structuredContent?.task_run as any).run_id as string;

    const bulk = await bulkProgressToolHandlers.startHandler('default', {
      run_id: runId,
      expected_total: 3,
      stop_condition: 'processed all input urls',
      item_key: 'url',
      completed: ['https://example.com'],
    }, undefined as any);
    const contractId = (bulk.structuredContent?.bulk_progress_contract as any).contract_id as string;

    const blocked = await taskRunToolHandlers.completeHandler('default', { run_id: runId }, undefined as any);
    expect(blocked.isError).toBe(true);
    expect((blocked.structuredContent?.error as any).code).toBe('bulk_completion_guard_failed');
    expect((blocked.structuredContent?.completion_guard as any).missing_count).toBe(2);
    expect((blocked.structuredContent?._hintMeta as any).severity).toBe('warning');

    await bulkProgressToolHandlers.updateHandler('default', {
      contract_id: contractId,
      completed: ['https://news.ycombinator.com', 'https://www.iana.org/domains/reserved'],
    }, undefined as any);

    const completed = await taskRunToolHandlers.completeHandler('default', { run_id: runId }, undefined as any);
    expect(completed.isError).toBeUndefined();
    expect((completed.structuredContent?.task_run as any).status).toBe('COMPLETED');
  });
});
