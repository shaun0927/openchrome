/// <reference types="jest" />

import {
  createSequentialInitTask,
  createBatchInitTask,
  createAllInitOverheadTasks,
} from './parallel-init-overhead';
import {
  createNoFaultToleranceTask,
  createCircuitBreakerTask,
  createAllFaultToleranceTasks,
} from './parallel-fault-tolerance';
import {
  createAllScalabilityTasks,
  computeScalabilityCurve,
  ScalabilityPoint,
} from './parallel-scalability';
import { MCPAdapter, MCPToolResult } from '../benchmark-runner';

class StubAdapter implements MCPAdapter {
  name = 'stub';
  mode = 'test';
  callCount = 0;
  lastToolName = '';
  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    this.callCount++;
    this.lastToolName = toolName;
    return { content: [{ type: 'text', text: 'ok' }] };
  }
  reset() { this.callCount = 0; }
}

// ─── Category 5: Init Overhead ───────────────────────────────────────────────

describe('Category 5: Init Overhead', () => {
  describe('createAllInitOverheadTasks', () => {
    test('returns 8 tasks (4 scales × 2 modes)', () => {
      const tasks = createAllInitOverheadTasks();
      expect(tasks).toHaveLength(8);
    });
  });

  describe('createSequentialInitTask', () => {
    test('sequential at 5x produces 10 tool calls (2 × 5: tabs_create + navigate)', async () => {
      const adapter = new StubAdapter();
      const task = createSequentialInitTask(5);
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(10);
      expect(adapter.callCount).toBe(10);
    });

    test('task name follows correct pattern "sequential-init-5x"', () => {
      const task = createSequentialInitTask(5);
      expect(task.name).toBe('sequential-init-5x');
    });
  });

  describe('createBatchInitTask', () => {
    test('batch at 5x produces 1 tool call (single workflow_init)', async () => {
      const adapter = new StubAdapter();
      const task = createBatchInitTask(5);
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(1);
      expect(adapter.callCount).toBe(1);
    });

    test('task name follows correct pattern "parallel-init-5x"', () => {
      const task = createBatchInitTask(5);
      expect(task.name).toBe('parallel-init-5x');
    });

    test('batch metadata includes initMethod mentioning workflow_init', async () => {
      const adapter = new StubAdapter();
      const task = createBatchInitTask(5);
      const result = await task.run(adapter);
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.initMethod).toContain('workflow_init');
    });
  });

  describe('task names in createAllInitOverheadTasks', () => {
    test('task names follow correct patterns for all scales', () => {
      const tasks = createAllInitOverheadTasks();
      const names = tasks.map((t) => t.name);
      expect(names).toContain('sequential-init-3x');
      expect(names).toContain('parallel-init-3x');
      expect(names).toContain('sequential-init-5x');
      expect(names).toContain('parallel-init-5x');
    });
  });
});

// ─── Category 6: Fault Tolerance ─────────────────────────────────────────────

describe('Category 6: Fault Tolerance', () => {
  describe('createAllFaultToleranceTasks', () => {
    test('returns 2 tasks', () => {
      const tasks = createAllFaultToleranceTasks();
      expect(tasks).toHaveLength(2);
    });
  });

  describe('createNoFaultToleranceTask', () => {
    test('no-fault at 5x: 21 total tool calls', async () => {
      // 5×navigate + 5×read + 1×7(stale retries) + 4×1(normal updates) = 21
      const adapter = new StubAdapter();
      const task = createNoFaultToleranceTask(5);
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(21);
    });

    test('no-fault metadata has wastedCalls: 6 (staleRetries - 1)', async () => {
      const adapter = new StubAdapter();
      const task = createNoFaultToleranceTask(5);
      const result = await task.run(adapter);
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.wastedCalls).toBe(6);
    });

    test('returns success: true', async () => {
      const adapter = new StubAdapter();
      const task = createNoFaultToleranceTask(5);
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
    });
  });

  describe('createCircuitBreakerTask', () => {
    test('circuit-breaker at 5x: 20 total tool calls', async () => {
      // 1(init) + 5×navigate + 5×read + 1×3(stale limited) + 4×1(normal) + 1(partial) + 1(final) = 20
      const adapter = new StubAdapter();
      const task = createCircuitBreakerTask(5);
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(20);
    });

    test('circuit-breaker metadata has savedCalls: 4 (7 - 3)', async () => {
      const adapter = new StubAdapter();
      const task = createCircuitBreakerTask(5);
      const result = await task.run(adapter);
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.savedCalls).toBe(4);
    });

    test('returns success: true', async () => {
      const adapter = new StubAdapter();
      const task = createCircuitBreakerTask(5);
      const result = await task.run(adapter);
      expect(result.success).toBe(true);
    });
  });
});

// ─── Category 7: Scalability ──────────────────────────────────────────────────

describe('Category 7: Scalability', () => {
  describe('createAllScalabilityTasks', () => {
    test('returns 14 tasks (7 scales × 2 modes)', () => {
      const tasks = createAllScalabilityTasks();
      expect(tasks).toHaveLength(14);
    });

    test('scales include [1, 2, 3, 5, 10, 20, 50]', () => {
      const tasks = createAllScalabilityTasks();
      const names = tasks.map((t) => t.name);
      for (const n of [1, 2, 3, 5, 10, 20, 50]) {
        expect(names).toContain(`sequential-scale-${n}x`);
        expect(names).toContain(`parallel-scale-${n}x`);
      }
    });

    test('task names follow "sequential-scale-Nx" / "parallel-scale-Nx" pattern', () => {
      const tasks = createAllScalabilityTasks();
      const names = tasks.map((t) => t.name);
      expect(names).toContain('sequential-scale-3x');
      expect(names).toContain('parallel-scale-3x');
    });

    test('sequential at 3x produces 6 tool calls (2 × 3)', async () => {
      const adapter = new StubAdapter();
      const tasks = createAllScalabilityTasks();
      const seq3 = tasks.find((t) => t.name === 'sequential-scale-3x')!;
      const result = await seq3.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(6);
    });

    test('parallel at 3x produces 8 tool calls (2×3 + 2 overhead)', async () => {
      const adapter = new StubAdapter();
      const tasks = createAllScalabilityTasks();
      const par3 = tasks.find((t) => t.name === 'parallel-scale-3x')!;
      const result = await par3.run(adapter);
      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(8);
    });
  });

  describe('computeScalabilityCurve', () => {
    test('computes correct speedup and efficiency', () => {
      const results = [
        { name: 'sequential-scale-3x', wallTimeMs: 300, toolCallCount: 6 },
        { name: 'parallel-scale-3x', wallTimeMs: 100, toolCallCount: 8 },
      ];
      const curve = computeScalabilityCurve(results);
      expect(curve).toHaveLength(1);
      const point = curve[0];
      expect(point.n).toBe(3);
      expect(point.seqToolCalls).toBe(6);
      expect(point.parToolCalls).toBe(8);
      expect(point.speedupFactor).toBe(3);
      // efficiency = speedup / n = 3 / 3 = 1.0 → 100.00
      expect(point.parallelEfficiency).toBe(100);
    });

    test('returns empty array for unmatched results', () => {
      const results = [
        { name: 'sequential-scale-3x', wallTimeMs: 300, toolCallCount: 6 },
        // missing parallel-scale-3x
      ];
      const curve = computeScalabilityCurve(results);
      expect(curve).toHaveLength(0);
    });
  });
});
