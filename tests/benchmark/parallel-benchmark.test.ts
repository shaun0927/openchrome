/// <reference types="jest" />

import {
  createSequentialBaselineTask,
  createParallelTask,
  createParallelBenchmarkPair,
  createAllParallelTasks,
} from './tasks/parallel';
import { MCPAdapter, MCPToolResult } from './benchmark-runner';

function makeMockAdapter(): MCPAdapter {
  return {
    name: 'MockAdapter',
    mode: 'test',
    callTool: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'mock response' }],
    } as MCPToolResult),
  };
}

describe('Parallel Benchmark Tasks', () => {
  describe('createSequentialBaselineTask', () => {
    test('creates task with correct name for 3x', () => {
      const task = createSequentialBaselineTask(3);
      expect(task.name).toBe('sequential-3x');
    });

    test('creates task with correct name for 20x', () => {
      const task = createSequentialBaselineTask(20);
      expect(task.name).toBe('sequential-20x');
    });

    test('runs N navigate + N read calls (2N total) for sequential', async () => {
      const adapter = makeMockAdapter();
      const task = createSequentialBaselineTask(5);

      const result = await task.run(adapter);

      expect(result.success).toBe(true);
      // 5 pages × 2 calls each (navigate + read) = 10 calls
      expect(result.toolCallCount).toBe(10);
      expect(adapter.callTool).toHaveBeenCalledTimes(10);
    });

    test('uses single tab (tab1) for all pages', async () => {
      const adapter = makeMockAdapter();
      const task = createSequentialBaselineTask(3);

      await task.run(adapter);

      const calls = (adapter.callTool as jest.Mock).mock.calls;
      // All navigate and read calls use tab1
      for (const call of calls) {
        if (call[0] === 'navigate' || call[0] === 'read_page') {
          expect(call[1].tabId).toBe('tab1');
        }
      }
    });

    test('records metadata with mode=sequential', async () => {
      const adapter = makeMockAdapter();
      const task = createSequentialBaselineTask(3);

      const result = await task.run(adapter);

      expect(result.metadata).toBeDefined();
      expect(result.metadata!.mode).toBe('sequential');
      expect(result.metadata!.concurrency).toBe(3);
      expect(result.metadata!.totalPages).toBe(3);
    });

    test('handles adapter errors gracefully', async () => {
      const adapter = makeMockAdapter();
      (adapter.callTool as jest.Mock).mockRejectedValueOnce(new Error('connection lost'));

      const task = createSequentialBaselineTask(3);
      const result = await task.run(adapter);

      expect(result.success).toBe(false);
      expect(result.error).toContain('connection lost');
    });

    test('tracks inputChars and outputChars', async () => {
      const adapter = makeMockAdapter();
      const task = createSequentialBaselineTask(3);

      const result = await task.run(adapter);

      expect(result.inputChars).toBeGreaterThan(0);
      expect(result.outputChars).toBeGreaterThan(0);
    });
  });

  describe('createParallelTask', () => {
    test('creates task with correct name for 5x', () => {
      const task = createParallelTask(5);
      expect(task.name).toBe('parallel-5x');
    });

    test('uses workflow_init and workflow_collect', async () => {
      const adapter = makeMockAdapter();
      const task = createParallelTask(3);

      await task.run(adapter);

      const toolNames = (adapter.callTool as jest.Mock).mock.calls.map(
        (c: unknown[]) => c[0]
      );
      expect(toolNames[0]).toBe('workflow_init');
      expect(toolNames[toolNames.length - 1]).toBe('workflow_collect');
    });

    test('uses separate tab IDs (tab-0, tab-1, ...) for parallel', async () => {
      const adapter = makeMockAdapter();
      const task = createParallelTask(3);

      await task.run(adapter);

      const calls = (adapter.callTool as jest.Mock).mock.calls;
      const navigateCalls = calls.filter((c: unknown[]) => c[0] === 'navigate');
      const readCalls = calls.filter((c: unknown[]) => c[0] === 'read_page');

      // Each page gets its own tab
      const navTabIds = navigateCalls.map((c: unknown[]) => (c[1] as Record<string, unknown>).tabId);
      const readTabIds = readCalls.map((c: unknown[]) => (c[1] as Record<string, unknown>).tabId);

      expect(navTabIds).toEqual(['tab-0', 'tab-1', 'tab-2']);
      expect(readTabIds).toEqual(['tab-0', 'tab-1', 'tab-2']);
    });

    test('has 2N + 2 tool calls (init + N nav + N read + collect)', async () => {
      const adapter = makeMockAdapter();
      const task = createParallelTask(5);

      const result = await task.run(adapter);

      // workflow_init(1) + navigate(5) + read_page(5) + workflow_collect(1) = 12
      expect(result.toolCallCount).toBe(12);
    });

    test('records metadata with mode=parallel and overheadToolCalls', async () => {
      const adapter = makeMockAdapter();
      const task = createParallelTask(3);

      const result = await task.run(adapter);

      expect(result.metadata).toBeDefined();
      expect(result.metadata!.mode).toBe('parallel');
      expect(result.metadata!.concurrency).toBe(3);
      expect(result.metadata!.overheadToolCalls).toBe(2);
    });

    test('handles adapter errors gracefully', async () => {
      const adapter = makeMockAdapter();
      (adapter.callTool as jest.Mock).mockRejectedValueOnce(new Error('init failed'));

      const task = createParallelTask(3);
      const result = await task.run(adapter);

      expect(result.success).toBe(false);
      expect(result.error).toContain('init failed');
    });
  });

  describe('createParallelBenchmarkPair', () => {
    test('returns [sequential, parallel] pair', () => {
      const [seq, par] = createParallelBenchmarkPair(5);

      expect(seq.name).toBe('sequential-5x');
      expect(par.name).toBe('parallel-5x');
    });

    test('sequential has more tool calls than parallel overhead', async () => {
      const adapter = makeMockAdapter();
      const [seq, par] = createParallelBenchmarkPair(5);

      const seqResult = await seq.run(adapter);
      // Reset mock for parallel run
      (adapter.callTool as jest.Mock).mockClear();
      const parResult = await par.run(adapter);

      // Sequential: 10 calls, Parallel: 12 calls (but wall time is 1/5th)
      // The +2 overhead is from workflow_init/collect which enable concurrency
      expect(seqResult.toolCallCount).toBe(10);
      expect(parResult.toolCallCount).toBe(12);
      expect(parResult.metadata!.overheadToolCalls).toBe(2);
    });
  });

  describe('createAllParallelTasks', () => {
    test('creates 6 tasks for scales 3x, 5x, 20x', () => {
      const tasks = createAllParallelTasks();

      expect(tasks).toHaveLength(6);
      expect(tasks.map((t) => t.name)).toEqual([
        'sequential-3x',
        'parallel-3x',
        'sequential-5x',
        'parallel-5x',
        'sequential-20x',
        'parallel-20x',
      ]);
    });

    test('20x sequential produces 40 tool calls', async () => {
      const adapter = makeMockAdapter();
      const tasks = createAllParallelTasks();
      const seq20 = tasks.find((t) => t.name === 'sequential-20x')!;

      const result = await seq20.run(adapter);

      // 20 × (navigate + read) = 40
      expect(result.toolCallCount).toBe(40);
    });

    test('20x parallel produces 42 tool calls (40 + 2 overhead)', async () => {
      const adapter = makeMockAdapter();
      const tasks = createAllParallelTasks();
      const par20 = tasks.find((t) => t.name === 'parallel-20x')!;

      const result = await par20.run(adapter);

      // 1 init + 20 nav + 20 read + 1 collect = 42
      expect(result.toolCallCount).toBe(42);
    });

    test('URLs cycle through 3 fixtures for scales > 3', async () => {
      const adapter = makeMockAdapter();
      const tasks = createAllParallelTasks();
      const par5 = tasks.find((t) => t.name === 'parallel-5x')!;

      await par5.run(adapter);

      const navCalls = (adapter.callTool as jest.Mock).mock.calls.filter(
        (c: unknown[]) => c[0] === 'navigate'
      );
      const urls = navCalls.map((c: unknown[]) => (c[1] as Record<string, unknown>).url);

      // 5 URLs cycling through 3 fixtures
      expect(urls).toHaveLength(5);
      expect(urls[0]).toContain('complex-page');
      expect(urls[1]).toContain('form-page');
      expect(urls[2]).toContain('multi-step');
      expect(urls[3]).toContain('complex-page'); // cycles back
      expect(urls[4]).toContain('form-page');
    });
  });
});
