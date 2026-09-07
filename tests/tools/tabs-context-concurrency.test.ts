import { registerTabsContextTool } from '../../src/tools/tabs-context';
import { getSessionManager } from '../../src/session-manager';
import type { ToolHandler } from '../../src/types/mcp';

jest.mock('../../src/session-manager', () => ({ getSessionManager: jest.fn() }));
jest.mock('../../src/core/page/safe-title', () => ({ safeTitle: async () => 'Fixture' }));

test('tab reads run concurrently in bounded batches and retain target order', async () => {
  let handler!: ToolHandler;
  registerTabsContextTool({ registerTool: (_name: string, value: ToolHandler) => { handler = value; } } as any);
  const ids = Array.from({ length: 7 }, (_, i) => `tab-${i}`);
  const releases: Array<() => void> = [];
  const getPage = jest.fn((_session, id: string) => new Promise(resolve => {
    releases.push(() => resolve({ url: () => `https://example.test/${id}` }));
  }));
  (getSessionManager as jest.Mock).mockReturnValue({
    getOrCreateSession: async () => ({ defaultWorkerId: 'default' }),
    getWorkers: () => [{ id: 'default', name: 'default' }],
    getWorkerTargetIds: () => ids,
    getTargetContextName: () => 'default', getPage,
  });
  const result = handler('session', {});
  await new Promise(resolve => setImmediate(resolve));
  expect(getPage).toHaveBeenCalledTimes(5);
  for (const release of releases.slice().reverse()) release();
  await new Promise(resolve => setImmediate(resolve));
  expect(getPage).toHaveBeenCalledTimes(7);
  for (const release of releases.slice(5).reverse()) release();
  const completed = await result;
  expect(completed.isError).not.toBe(true);
  const workers = completed.structuredContent!.workers as Array<{ tabs: Array<{ tabId: string }> }>;
  expect(workers[0].tabs.map(tab => tab.tabId)).toEqual(ids);
});
