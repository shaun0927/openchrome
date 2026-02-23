/// <reference types="jest" />

import {
  createMultistepSequentialTask,
  createMultistepParallelTask,
  createAllMultistepTasks,
} from './parallel-multistep';
import {
  createSequentialJSTask,
  createBatchJSTask,
  createAllBatchJSTasks,
} from './parallel-batch-js';
import {
  createAgentDrivenTask,
  createExecutePlanTask,
  createExecutePlanBenchmarkPair,
} from './parallel-execute-plan';
import {
  createBlockingCollectTask,
  createStreamingCollectTask,
  createAllStreamingTasks,
} from './parallel-streaming';
import { MCPAdapter, MCPToolResult } from '../benchmark-runner';

class StubAdapter implements MCPAdapter {
  name = 'stub';
  mode = 'test';
  callCount = 0;
  lastToolName = '';
  async callTool(toolName: string, _args: Record<string, unknown>): Promise<MCPToolResult> {
    this.callCount++;
    this.lastToolName = toolName;
    return { content: [{ type: 'text', text: 'ok' }] };
  }
  reset() {
    this.callCount = 0;
  }
}

// ─── Category 1: Multi-Step ────────────────────────────────────────────────

describe('Category 1: Multi-Step (parallel-multistep)', () => {
  describe('createAllMultistepTasks', () => {
    test('returns 6 tasks (3 scales × 2 modes)', () => {
      const tasks = createAllMultistepTasks();
      expect(tasks).toHaveLength(6);
    });
  });

  describe('createMultistepSequentialTask', () => {
    test('sequential task at 3x produces 27 tool calls (9 × 3)', async () => {
      const adapter = new StubAdapter();
      const task = createMultistepSequentialTask(3);
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(27);
    });

    test('sequential task name matches pattern "sequential-multistep-3x"', () => {
      const task = createMultistepSequentialTask(3);
      expect(task.name).toBe('sequential-multistep-3x');
    });

    test('metadata includes correct concurrency and mode', async () => {
      const adapter = new StubAdapter();
      const task = createMultistepSequentialTask(3);
      const result = await task.run(adapter);
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.concurrency).toBe(3);
      expect(result.metadata!.mode).toBe('sequential');
    });
  });

  describe('createMultistepParallelTask', () => {
    test('parallel task at 3x produces 29 tool calls (27 + 2 overhead: init + collect)', async () => {
      const adapter = new StubAdapter();
      const task = createMultistepParallelTask(3);
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(29);
    });

    test('parallel task name matches pattern "parallel-multistep-3x"', () => {
      const task = createMultistepParallelTask(3);
      expect(task.name).toBe('parallel-multistep-3x');
    });

    test('metadata includes correct concurrency and mode', async () => {
      const adapter = new StubAdapter();
      const task = createMultistepParallelTask(3);
      const result = await task.run(adapter);
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.concurrency).toBe(3);
      expect(result.metadata!.mode).toBe('parallel');
    });
  });
});

// ─── Category 2: Batch JS ─────────────────────────────────────────────────

describe('Category 2: Batch JS (parallel-batch-js)', () => {
  describe('createAllBatchJSTasks', () => {
    test('returns 8 tasks (4 scales × 2 modes)', () => {
      const tasks = createAllBatchJSTasks();
      expect(tasks).toHaveLength(8);
    });
  });

  describe('createSequentialJSTask', () => {
    test('sequential at 5x produces 10 tool calls (2 × 5)', async () => {
      const adapter = new StubAdapter();
      const task = createSequentialJSTask(5);
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(10);
    });

    test('task name follows correct pattern', () => {
      const task = createSequentialJSTask(5);
      expect(task.name).toBe('sequential-batch-js-5x');
    });
  });

  describe('createBatchJSTask', () => {
    test('batch at 5x produces 6 tool calls (5 nav + 1 batch_execute)', async () => {
      const adapter = new StubAdapter();
      const task = createBatchJSTask(5);
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(6);
    });

    test('task name follows correct pattern', () => {
      const task = createBatchJSTask(5);
      expect(task.name).toBe('parallel-batch-js-5x');
    });
  });
});

// ─── Category 3: Execute Plan ─────────────────────────────────────────────

describe('Category 3: Execute Plan (parallel-execute-plan)', () => {
  describe('createAgentDrivenTask', () => {
    test('agent-driven task produces 6 tool calls', async () => {
      const adapter = new StubAdapter();
      const task = createAgentDrivenTask();
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(6);
    });

    test('agent-driven metadata has llmRoundTrips: 6', async () => {
      const adapter = new StubAdapter();
      const task = createAgentDrivenTask();
      const result = await task.run(adapter);
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.llmRoundTrips).toBe(6);
    });
  });

  describe('createExecutePlanTask', () => {
    test('execute plan task produces 1 tool call', async () => {
      const adapter = new StubAdapter();
      const task = createExecutePlanTask();
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(1);
    });

    test('execute plan metadata has llmRoundTrips: 0', async () => {
      const adapter = new StubAdapter();
      const task = createExecutePlanTask();
      const result = await task.run(adapter);
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.llmRoundTrips).toBe(0);
    });
  });

  describe('createExecutePlanBenchmarkPair', () => {
    test('returns exactly 2 tasks', () => {
      const pair = createExecutePlanBenchmarkPair();
      expect(pair).toHaveLength(2);
    });
  });
});

// ─── Category 4: Streaming ────────────────────────────────────────────────

describe('Category 4: Streaming (parallel-streaming)', () => {
  describe('createAllStreamingTasks', () => {
    test('returns 4 tasks (2 scales × 2 modes)', () => {
      const tasks = createAllStreamingTasks();
      expect(tasks).toHaveLength(4);
    });
  });

  describe('createBlockingCollectTask', () => {
    test('blocking at 3x: 1 (init) + 6 (3×navigate + 3×read) + 1 (collect) = 8 tool calls', async () => {
      const adapter = new StubAdapter();
      const task = createBlockingCollectTask(3);
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(8);
    });
  });

  describe('createStreamingCollectTask', () => {
    test('streaming at 3x: 1 (init) + 6 (3×navigate + 3×read) + 1 (partial) + 1 (final collect) = 9 tool calls', async () => {
      const adapter = new StubAdapter();
      const task = createStreamingCollectTask(3);
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(9);
    });

    test('streaming metadata includes timeToFirstResult', async () => {
      const adapter = new StubAdapter();
      const task = createStreamingCollectTask(3);
      const result = await task.run(adapter);
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.timeToFirstResult).toBeDefined();
    });
  });
});
