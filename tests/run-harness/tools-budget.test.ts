/// <reference types="jest" />

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunStore } from '../../src/run-harness/store';
import { registerRunHarnessTools } from '../../src/run-harness/tools';

jest.mock('../../src/run-harness/store', () => {
  const actual = jest.requireActual('../../src/run-harness/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-run-tools-budget-'));
  let now = 1000;
  const store = new actual.RunStore({ rootDir: dir, now: () => now++, idFactory: () => `tool-budget-${now}` });
  return { ...actual, getRunStore: () => store };
});

describe('oc_run_status budget guard', () => {
  it('finishes the run as needs_strategy_change and records evidence metadata', async () => {
    const handlers = new Map<string, any>();
    registerRunHarnessTools({ registerTool: (name: string, handler: any) => handlers.set(name, handler) } as any);
    const start = JSON.parse((await handlers.get('oc_run_start')('s1', { run_id: 'budget-tool' })).content[0].text);
    expect(start.status).toBe('running');

    const store = (jest.requireMock('../../src/run-harness/store').getRunStore() as RunStore);
    store.appendToolFinished({ run_id: 'budget-tool', tool: 'interact', ok: false, message: 'element not found' });
    store.appendToolFinished({ run_id: 'budget-tool', tool: 'interact', ok: false, message: 'element not found' });

    const statusResult = await handlers.get('oc_run_status')('s1', {
      run_id: 'budget-tool',
      budget: { max_same_tool_retries: 1 },
    });
    const status = JSON.parse(statusResult.content[0].text);
    expect(statusResult.isError).toBe(true);
    expect(status.status).toBe('needs_strategy_change');
    expect(status.budget.category).toBe('LLM_WANDERING');

    const events = JSON.parse((await handlers.get('oc_run_events')('s1', { run_id: 'budget-tool' })).content[0].text).events;
    expect(events[events.length - 1].kind).toBe('run_finished');
    expect(events[events.length - 1].metadata.failureCategory).toBe('LLM_WANDERING');
  });
});
