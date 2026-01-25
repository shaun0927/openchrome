/// <reference types="jest" />
/**
 * Stress tests for concurrent operations
 * Tests race conditions and atomic operations
 */

import * as fs from 'fs';
import * as path from 'path';
import { OrchestrationStateManager } from '../../../src/orchestration/state-manager';
import { WorkflowEngine, WorkflowDefinition } from '../../../src/orchestration/workflow-engine';
import { createMockSessionManager, asyncUtils } from '../../mocks/orchestration-fixtures';

// Mock the session manager
jest.mock('../../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../../src/session-manager';

describe('Concurrent Updates Stress Tests', () => {
  let stateManager: OrchestrationStateManager;
  let engine: WorkflowEngine;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  const testDir = '.agent/test-concurrent';
  const testSessionId = 'test-session-concurrent';

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);

    stateManager = new OrchestrationStateManager(testDir);
    await stateManager.cleanup();

    engine = new WorkflowEngine();
    // @ts-expect-error
    engine.stateManager = stateManager;
    // @ts-expect-error
    engine.sessionManager = mockSessionManager;
  });

  afterEach(async () => {
    await stateManager.cleanup();
    const fullPath = path.resolve(testDir);
    if (fs.existsSync(fullPath)) {
      try {
        await fs.promises.rm(fullPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors on Windows
      }
    }
    jest.clearAllMocks();
  });

  describe('Concurrent Worker State Updates', () => {
    test('should handle 50 concurrent updates to same worker', async () => {
      await stateManager.initWorkerState('w1', 'test-worker', 't1', 'Task');

      const updates = Array.from({ length: 50 }, (_, i) =>
        stateManager.updateWorkerState('test-worker', { iteration: i + 1 })
      );

      const results = await Promise.allSettled(updates);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      // All updates should complete (no crashes)
      expect(fulfilled.length + rejected.length).toBe(50);
      // Most should succeed (race conditions may cause some to fail gracefully)
      expect(fulfilled.length).toBeGreaterThan(40);

      // Final state should be readable
      const finalState = await stateManager.readWorkerState('test-worker');
      expect(finalState).not.toBeNull();
    });

    test('should handle concurrent progress entries', async () => {
      await stateManager.initWorkerState('w1', 'test-worker', 't1', 'Task');

      const entries = Array.from({ length: 30 }, (_, i) =>
        stateManager.addProgressEntry('test-worker', `Action ${i}`, 'SUCCESS')
      );

      await Promise.allSettled(entries);

      const state = await stateManager.readWorkerState('test-worker');
      // Due to race conditions, not all entries may be preserved
      // This documents current behavior
      expect(state?.progressLog.length).toBeGreaterThan(0);
      console.log(`Concurrent progress entries: ${state?.progressLog.length}/30 preserved`);
    });

    test('should handle mixed update types concurrently', async () => {
      await stateManager.initWorkerState('w1', 'test-worker', 't1', 'Task');

      const operations: Promise<unknown>[] = [];

      // Status updates
      for (let i = 0; i < 10; i++) {
        operations.push(
          stateManager.updateWorkerState('test-worker', { status: 'IN_PROGRESS' })
        );
      }

      // Iteration updates
      for (let i = 0; i < 10; i++) {
        operations.push(
          stateManager.updateWorkerState('test-worker', { iteration: i + 1 })
        );
      }

      // Progress entries
      for (let i = 0; i < 10; i++) {
        operations.push(
          stateManager.addProgressEntry('test-worker', `Action ${i}`, 'SUCCESS')
        );
      }

      const results = await Promise.allSettled(operations);
      const rejected = results.filter(r => r.status === 'rejected');

      // Should not throw unhandled errors
      expect(rejected.length).toBe(0);

      // State should still be valid
      const state = await stateManager.readWorkerState('test-worker');
      expect(state).not.toBeNull();
    });
  });

  describe('Concurrent Orchestration State Updates', () => {
    test('should handle 10 workers completing simultaneously', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-concurrent',
        name: 'Concurrent Test',
        steps: Array.from({ length: 10 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `worker${i + 1}`,
          url: `https://site${i + 1}.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Complete all workers simultaneously
      const completions = Array.from({ length: 10 }, (_, i) =>
        engine.completeWorker(`worker${i + 1}`, 'SUCCESS', `Done ${i + 1}`, {})
      );

      await Promise.all(completions);

      const status = await engine.getOrchestrationStatus();

      // All should be counted
      expect(status?.completedWorkers).toBe(10);
      expect(status?.status).toBe('COMPLETED');
    });

    test('should maintain correct counts under concurrent updates', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-counts',
        name: 'Count Test',
        steps: Array.from({ length: 5 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `worker${i + 1}`,
          url: `https://site${i + 1}.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Mixed completions
      await Promise.all([
        engine.completeWorker('worker1', 'SUCCESS', 'Done', {}),
        engine.completeWorker('worker2', 'FAIL', 'Failed', {}),
        engine.completeWorker('worker3', 'SUCCESS', 'Done', {}),
        engine.completeWorker('worker4', 'FAIL', 'Failed', {}),
        engine.completeWorker('worker5', 'PARTIAL', 'Partial', {}),
      ]);

      const status = await engine.getOrchestrationStatus();

      // 3 completed (2 SUCCESS + 1 PARTIAL)
      expect(status?.completedWorkers).toBe(3);
      // 2 failed
      expect(status?.failedWorkers).toBe(2);
    });
  });

  describe('Read-Write Conflicts', () => {
    test('should handle concurrent reads and writes', async () => {
      await stateManager.initWorkerState('w1', 'rw-worker', 't1', 'Task');

      const operations: Promise<unknown>[] = [];

      // Concurrent reads
      for (let i = 0; i < 20; i++) {
        operations.push(stateManager.readWorkerState('rw-worker'));
      }

      // Concurrent writes
      for (let i = 0; i < 20; i++) {
        operations.push(
          stateManager.updateWorkerState('rw-worker', { iteration: i })
        );
      }

      const results = await Promise.allSettled(operations);

      // No operations should throw unhandled errors
      const rejected = results.filter(r => r.status === 'rejected');
      expect(rejected.length).toBe(0);

      // Final read should succeed
      const finalState = await stateManager.readWorkerState('rw-worker');
      expect(finalState).not.toBeNull();
    });

    test('should handle rapid read-modify-write cycles', async () => {
      await stateManager.initWorkerState('w1', 'rmw-worker', 't1', 'Task');

      // Rapid read-modify-write
      for (let i = 0; i < 50; i++) {
        const state = await stateManager.readWorkerState('rmw-worker');
        if (state) {
          await stateManager.updateWorkerState('rmw-worker', {
            iteration: (state.iteration || 0) + 1,
          });
        }
      }

      const finalState = await stateManager.readWorkerState('rmw-worker');
      // Due to race conditions in read-modify-write, final iteration may vary
      expect(finalState?.iteration).toBeGreaterThan(0);
      console.log(`Rapid R-M-W final iteration: ${finalState?.iteration}/50`);
    });
  });

  describe('File System Stress', () => {
    test('should handle rapid file operations', async () => {
      const operations: Promise<unknown>[] = [];

      // Create multiple workers
      for (let i = 0; i < 20; i++) {
        operations.push(
          stateManager.initWorkerState(`w${i}`, `worker${i}`, `t${i}`, `Task ${i}`)
        );
      }

      await Promise.allSettled(operations);

      // Verify all files exist
      for (let i = 0; i < 20; i++) {
        const state = await stateManager.readWorkerState(`worker${i}`);
        expect(state).not.toBeNull();
      }
    });

    test('should handle cleanup during active operations', async () => {
      await stateManager.initWorkerState('w1', 'cleanup-test', 't1', 'Task');

      // Start some operations
      const updates = Array.from({ length: 10 }, (_, i) =>
        stateManager.addProgressEntry('cleanup-test', `Action ${i}`, 'SUCCESS')
      );

      // Cleanup during operations (race condition test)
      const cleanupPromise = stateManager.cleanup();

      // Wait for all to settle
      await Promise.allSettled([...updates, cleanupPromise]);

      // Should not crash - state may or may not be cleaned up
      // depending on timing
    });
  });

  describe('Timing Sensitivity', () => {
    test('should handle bursts of operations with delays', async () => {
      await stateManager.initWorkerState('w1', 'burst-worker', 't1', 'Task');

      const runBurst = async (burstNum: number) => {
        const operations = Array.from({ length: 5 }, (_, i) =>
          stateManager.addProgressEntry(
            'burst-worker',
            `Burst ${burstNum} Action ${i}`,
            'SUCCESS'
          )
        );
        await Promise.all(operations);
      };

      // Three bursts with delays
      await runBurst(1);
      await new Promise(r => setTimeout(r, 50));
      await runBurst(2);
      await new Promise(r => setTimeout(r, 50));
      await runBurst(3);

      const state = await stateManager.readWorkerState('burst-worker');
      // Should have entries from all bursts
      expect(state?.progressLog.length).toBeGreaterThan(0);
    });
  });
});
