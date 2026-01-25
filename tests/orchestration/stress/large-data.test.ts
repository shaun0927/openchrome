/// <reference types="jest" />
/**
 * Stress tests for large data handling
 * Tests memory usage and performance with large payloads
 */

import * as fs from 'fs';
import * as path from 'path';
import { OrchestrationStateManager } from '../../../src/orchestration/state-manager';
import { WorkflowEngine, WorkflowDefinition } from '../../../src/orchestration/workflow-engine';
import { createMockSessionManager, largeDataSamples, asyncUtils } from '../../mocks/orchestration-fixtures';

// Mock the session manager
jest.mock('../../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../../src/session-manager';

describe('Large Data Handling Stress Tests', () => {
  let stateManager: OrchestrationStateManager;
  let engine: WorkflowEngine;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  const testDir = '.agent/test-large-data';
  const testSessionId = 'test-session-large';

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

  describe('Large Progress Log', () => {
    test('should handle 1000 progress entries', async () => {
      await stateManager.initWorkerState('w1', 'large-log', 't1', 'Task');

      const { durationMs } = await asyncUtils.measureTime(async () => {
        for (let i = 0; i < 1000; i++) {
          await stateManager.addProgressEntry('large-log', `Action ${i}`, 'SUCCESS');
        }
      });

      const state = await stateManager.readWorkerState('large-log');
      expect(state?.progressLog).toHaveLength(1000);

      console.log(`1000 progress entries: ${durationMs}ms`);
      // Should complete in reasonable time (< 30 seconds)
      expect(durationMs).toBeLessThan(30000);
    }, 60000); // 60 second timeout

    test('should handle progress entries with long messages', async () => {
      await stateManager.initWorkerState('w1', 'long-msg', 't1', 'Task');

      const longMessage = 'x'.repeat(10000); // 10KB message

      await stateManager.addProgressEntry('long-msg', longMessage, 'SUCCESS');

      const state = await stateManager.readWorkerState('long-msg');
      expect(state?.progressLog[0].action).toBe(longMessage);
    });

    test('should handle many entries with errors', async () => {
      await stateManager.initWorkerState('w1', 'error-log', 't1', 'Task');

      for (let i = 0; i < 100; i++) {
        await stateManager.addProgressEntry(
          'error-log',
          `Action ${i}`,
          i % 3 === 0 ? 'FAIL' : 'SUCCESS',
          i % 3 === 0 ? `Error at iteration ${i}: Something went wrong with a detailed message` : undefined
        );
      }

      const state = await stateManager.readWorkerState('error-log');
      expect(state?.progressLog).toHaveLength(100);

      const errorEntries = state?.progressLog.filter(p => p.error);
      expect(errorEntries?.length).toBeGreaterThan(30);
    });
  });

  describe('Large Extracted Data', () => {
    test('should handle 10000-item extracted data', async () => {
      await stateManager.initWorkerState('w1', 'large-data', 't1', 'Task');

      const largeData = largeDataSamples.generateLargeData(10000);

      await stateManager.updateWorkerState('large-data', { extractedData: largeData });

      const state = await stateManager.readWorkerState('large-data');
      expect(state?.extractedData).toEqual(largeData);
    });

    test('should handle 1MB extracted data', async () => {
      await stateManager.initWorkerState('w1', 'mb-data', 't1', 'Task');

      // Create approximately 1MB of data
      const items = Array.from({ length: 5000 }, (_, i) => ({
        id: i,
        name: `Item ${i}`,
        description: 'x'.repeat(200), // ~200 bytes per item
      }));

      await stateManager.updateWorkerState('mb-data', { extractedData: { items } });

      const state = await stateManager.readWorkerState('mb-data');
      expect((state?.extractedData as { items: unknown[] }).items).toHaveLength(5000);

      // Check file size
      const filePath = stateManager.getWorkerPath('mb-data');
      const stats = fs.statSync(filePath);
      console.log(`1MB data file size: ${stats.size} bytes`);
    });

    test('should handle deeply nested data structures', async () => {
      await stateManager.initWorkerState('w1', 'nested', 't1', 'Task');

      // Create deeply nested structure
      const createNestedObject = (depth: number): unknown => {
        if (depth === 0) return { value: 'leaf' };
        return {
          level: depth,
          child: createNestedObject(depth - 1),
          siblings: [
            createNestedObject(Math.max(0, depth - 2)),
            createNestedObject(Math.max(0, depth - 2)),
          ],
        };
      };

      const nestedData = createNestedObject(10);

      await stateManager.updateWorkerState('nested', { extractedData: nestedData });

      const state = await stateManager.readWorkerState('nested');
      expect(state?.extractedData).toEqual(nestedData);
    });
  });

  describe('Large Number of Workers', () => {
    test('should handle 100 workers', async () => {
      const steps = Array.from({ length: 100 }, (_, i) => ({
        workerId: `w${i + 1}`,
        workerName: `worker${i + 1}`,
        url: `https://site${i + 1}.com`,
        task: `Task ${i + 1}`,
        successCriteria: 'Done',
      }));

      const workflow: WorkflowDefinition = {
        id: 'wf-100',
        name: '100 Workers Test',
        steps,
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      const { durationMs } = await asyncUtils.measureTime(async () => {
        await engine.initWorkflow(testSessionId, workflow);
      });

      console.log(`100 workers initialization: ${durationMs}ms`);

      const states = await engine.getAllWorkerStates();
      expect(states).toHaveLength(100);

      // Should complete in reasonable time
      expect(durationMs).toBeLessThan(10000);
    }, 30000);

    test('should handle 100 workers completing', async () => {
      const steps = Array.from({ length: 100 }, (_, i) => ({
        workerId: `w${i + 1}`,
        workerName: `w${i + 1}`,
        url: `https://site${i + 1}.com`,
        task: `Task ${i + 1}`,
        successCriteria: 'Done',
      }));

      const workflow: WorkflowDefinition = {
        id: 'wf-100-complete',
        name: '100 Workers Complete',
        steps,
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      const { durationMs } = await asyncUtils.measureTime(async () => {
        for (let i = 0; i < 100; i++) {
          await engine.completeWorker(`w${i + 1}`, 'SUCCESS', `Done ${i + 1}`, { index: i });
        }
      });

      console.log(`100 workers completion: ${durationMs}ms`);

      const status = await engine.getOrchestrationStatus();
      expect(status?.completedWorkers).toBe(100);
      expect(status?.status).toBe('COMPLETED');
    }, 60000);

    test('should collect results from 100 workers', async () => {
      const steps = Array.from({ length: 100 }, (_, i) => ({
        workerId: `w${i + 1}`,
        workerName: `w${i + 1}`,
        url: `https://site${i + 1}.com`,
        task: `Task ${i + 1}`,
        successCriteria: 'Done',
      }));

      const workflow: WorkflowDefinition = {
        id: 'wf-100-collect',
        name: '100 Workers Collect',
        steps,
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      for (let i = 0; i < 100; i++) {
        await engine.completeWorker(`w${i + 1}`, 'SUCCESS', `Done ${i + 1}`, {
          data: Array(10).fill(`item-${i}`),
        });
      }

      const { result: results, durationMs } = await asyncUtils.measureTime(async () => {
        return engine.collectResults();
      });

      console.log(`100 workers result collection: ${durationMs}ms`);

      expect(results?.workerResults).toHaveLength(100);
      expect(results?.completedCount).toBe(100);
    }, 60000);
  });

  describe('Long Running State', () => {
    test('should handle state file growing over time', async () => {
      await stateManager.initWorkerState('w1', 'growing', 't1', 'Task');

      // Simulate long-running worker with many updates
      for (let batch = 0; batch < 10; batch++) {
        for (let i = 0; i < 50; i++) {
          await stateManager.addProgressEntry(
            'growing',
            `Batch ${batch} Action ${i}`,
            i % 10 === 0 ? 'FAIL' : 'SUCCESS',
            i % 10 === 0 ? `Error in batch ${batch}` : undefined
          );
        }
        await stateManager.updateWorkerState('growing', { iteration: batch + 1 });
      }

      const state = await stateManager.readWorkerState('growing');
      expect(state?.progressLog).toHaveLength(500);
      expect(state?.iteration).toBe(10);

      // Check final file size
      const filePath = stateManager.getWorkerPath('growing');
      const stats = fs.statSync(filePath);
      console.log(`Growing state file size: ${stats.size} bytes after 500 entries`);
    }, 60000);
  });

  describe('Memory Efficiency', () => {
    test('should not leak memory during repeated operations', async () => {
      const initialMemory = process.memoryUsage().heapUsed;

      // Perform many operations
      for (let cycle = 0; cycle < 10; cycle++) {
        await stateManager.initWorkerState('w1', `cycle${cycle}`, 't1', 'Task');

        for (let i = 0; i < 100; i++) {
          await stateManager.addProgressEntry(`cycle${cycle}`, `Action ${i}`, 'SUCCESS');
        }

        // Read back
        await stateManager.readWorkerState(`cycle${cycle}`);
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      console.log(`Memory increase after 10 cycles: ${memoryIncrease / 1024 / 1024}MB`);

      // Memory increase should be reasonable (< 100MB)
      expect(memoryIncrease).toBeLessThan(100 * 1024 * 1024);
    }, 120000);
  });

  describe('String Content Edge Cases', () => {
    test('should handle special JSON characters in data', async () => {
      await stateManager.initWorkerState('w1', 'json-chars', 't1', 'Task');

      const specialData = {
        quotes: 'He said "hello"',
        backslash: 'path\\to\\file',
        newlines: 'line1\nline2\nline3',
        tabs: 'col1\tcol2\tcol3',
        unicode: '한글 日本語 العربية',
        emoji: '🎉🚀💡',
        control: 'control\x00\x01\x02chars',
      };

      await stateManager.updateWorkerState('json-chars', { extractedData: specialData });

      const state = await stateManager.readWorkerState('json-chars');
      expect(state?.extractedData).toEqual(specialData);
    });

    test('should handle markdown-like content in data', async () => {
      await stateManager.initWorkerState('w1', 'md-content', 't1', 'Task');

      const markdownContent = {
        code: '```javascript\nconsole.log("test");\n```',
        header: '# Title\n## Subtitle',
        list: '- item1\n- item2\n- item3',
        link: '[link](https://example.com)',
      };

      await stateManager.updateWorkerState('md-content', { extractedData: markdownContent });

      const state = await stateManager.readWorkerState('md-content');
      expect(state?.extractedData).toEqual(markdownContent);
    });
  });
});
