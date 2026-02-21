/// <reference types="jest" />
/**
 * Integration tests for 20+ parallel site crawling capability
 * Verifies OpenChrome can handle large-scale parallel worker execution
 */

import * as fs from 'fs';
import * as path from 'path';
import { WorkflowEngine, WorkflowDefinition } from '../../../src/orchestration/workflow-engine';
import { OrchestrationStateManager } from '../../../src/orchestration/state-manager';
import { createMockSessionManager, asyncUtils } from '../../mocks/orchestration-fixtures';

// Mock the session manager
jest.mock('../../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../../src/session-manager';

describe('20+ Parallel Crawl Capability', () => {
  let engine: WorkflowEngine;
  let stateManager: OrchestrationStateManager;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  const testDir = '.agent/test-parallel-crawl';
  const testSessionId = 'test-session-crawl';

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
        // Ignore cleanup errors
      }
    }
    jest.clearAllMocks();
  });

  describe('20 Worker Creation', () => {
    test('should create 20 workers for parallel crawling with unique IDs', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-parallel-crawl-20',
        name: 'Parallel Crawl 20 Sites',
        steps: Array.from({ length: 20 }, (_, i) => ({
          workerId: `site-worker-${String(i + 1).padStart(2, '0')}`,
          workerName: `site${String(i + 1).padStart(2, '0')}`,
          url: `https://site${i + 1}.example.com`,
          task: `Crawl site${i + 1}.example.com and extract pricing data`,
          successCriteria: `Pricing data from site${i + 1} extracted`,
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      const { orchestrationId, workers } = await engine.initWorkflow(testSessionId, workflow);

      // Verify 20 workers were created
      expect(workers).toHaveLength(20);

      // All workers should have unique workerIds
      const workerIds = workers.map(w => w.workerId);
      const uniqueIds = new Set(workerIds);
      expect(uniqueIds.size).toBe(20);

      // All workers should have unique tab IDs
      const tabIds = workers.map(w => w.tabId);
      const uniqueTabIds = new Set(tabIds);
      expect(uniqueTabIds.size).toBe(20);

      // Orchestration ID should be defined
      expect(orchestrationId).toBeTruthy();
      expect(typeof orchestrationId).toBe('string');
    });

    test('should assign correct worker names matching workflow steps', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-names-check-20',
        name: 'Worker Names Check',
        steps: Array.from({ length: 20 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `crawler-${i + 1}`,
          url: `https://crawler-${i + 1}.example.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      const { workers } = await engine.initWorkflow(testSessionId, workflow);

      // Verify worker names match what was defined
      const workerNames = workers.map(w => w.workerName);
      for (let i = 0; i < 20; i++) {
        expect(workerNames).toContain(`crawler-${i + 1}`);
      }
    });
  });

  describe('Worker State Isolation', () => {
    test('should maintain independent extracted data across 20 workers', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-isolation-20',
        name: 'State Isolation 20 Workers',
        steps: Array.from({ length: 20 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `isolate${i + 1}`,
          url: `https://isolate${i + 1}.example.com`,
          task: `Isolation task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Complete each worker with distinct data
      for (let i = 0; i < 20; i++) {
        await engine.completeWorker(`isolate${i + 1}`, 'SUCCESS', `Result ${i + 1}`, {
          siteIndex: i + 1,
          price: (i + 1) * 1000,
          url: `https://isolate${i + 1}.example.com/product`,
        });
      }

      // Verify each worker has its own isolated state
      for (let i = 0; i < 20; i++) {
        const state = await engine.getWorkerState(`isolate${i + 1}`);
        expect(state).not.toBeNull();
        expect((state?.extractedData as Record<string, unknown>)?.siteIndex).toBe(i + 1);
        expect((state?.extractedData as Record<string, unknown>)?.price).toBe((i + 1) * 1000);
      }
    });

    test('should create separate state files for each of 20 workers', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-files-20',
        name: 'Separate Files 20',
        steps: Array.from({ length: 20 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `filetest${i + 1}`,
          url: `https://filetest${i + 1}.example.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Each worker should have its own state file
      for (let i = 0; i < 20; i++) {
        const workerPath = stateManager.getWorkerPath(`filetest${i + 1}`);
        expect(fs.existsSync(workerPath)).toBe(true);
      }
    });

    test('should not contaminate worker state between different workers', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-cross-contamination-20',
        name: 'Cross Contamination Check 20',
        steps: Array.from({ length: 20 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `nocontam${i + 1}`,
          url: `https://nocontam${i + 1}.example.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Complete only first and last workers
      await engine.completeWorker('nocontam1', 'SUCCESS', 'First done', { marker: 'first' });
      await engine.completeWorker('nocontam20', 'SUCCESS', 'Last done', { marker: 'last' });

      // Verify intermediate workers are still in INIT state (not contaminated)
      const midState = await engine.getWorkerState('nocontam10');
      expect(midState?.status).toBe('INIT');
      expect(midState?.extractedData).toBeNull();

      // Verify first and last have their own distinct data
      const firstState = await engine.getWorkerState('nocontam1');
      const lastState = await engine.getWorkerState('nocontam20');
      expect((firstState?.extractedData as Record<string, unknown>)?.marker).toBe('first');
      expect((lastState?.extractedData as Record<string, unknown>)?.marker).toBe('last');
    });
  });

  describe('Parallel Execution Capacity', () => {
    test('should support all 20 workers running concurrently via Promise.all', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-concurrent-20',
        name: 'Concurrent 20 Workers',
        steps: Array.from({ length: 20 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `concurrent${i + 1}`,
          url: `https://concurrent${i + 1}.example.com`,
          task: `Concurrent task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      const { workers } = await engine.initWorkflow(testSessionId, workflow);
      expect(workers).toHaveLength(20);

      // Simulate parallel completion using asyncUtils.measureTime
      const { result: completionResults, durationMs } = await asyncUtils.measureTime(async () => {
        return asyncUtils.runConcurrently(
          async (i) => {
            // Sequential file writes to avoid I/O race conditions in tests
            await engine.completeWorker(`concurrent${i + 1}`, 'SUCCESS', `Site ${i + 1} done`, {
              crawled: true,
              index: i + 1,
            });
          },
          20
        );
      });

      // All 20 should have completed
      const successes = completionResults.filter(r => r.status === 'fulfilled');
      expect(successes).toHaveLength(20);

      // Verify orchestration engine tracked all completions
      const status = await engine.getOrchestrationStatus();
      expect(status?.workers).toHaveLength(20);

      console.log(`20 workers completed in ${durationMs}ms`);
    });

    test('should initialize 20 workers with parallel: true flag', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-parallel-flag-20',
        name: 'Parallel Flag 20',
        steps: Array.from({ length: 20 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `pflag${i + 1}`,
          url: `https://pflag${i + 1}.example.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      const { workers } = await engine.initWorkflow(testSessionId, workflow);

      // Verify all 20 workers are registered in orchestration state
      const orchStatus = await engine.getOrchestrationStatus();
      expect(orchStatus?.workers).toHaveLength(20);
      expect(orchStatus?.status).toBe('INIT');
      expect(workers).toHaveLength(20);
    });
  });

  describe('Result Collection', () => {
    test('should collect results from all 20 workers after completion', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-collect-20',
        name: 'Collect Results 20',
        steps: Array.from({ length: 20 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `collect${i + 1}`,
          url: `https://collect${i + 1}.example.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Complete all 20 workers sequentially to avoid file I/O race conditions
      for (let i = 0; i < 20; i++) {
        await engine.completeWorker(`collect${i + 1}`, 'SUCCESS', `Site ${i + 1} scraped`, {
          price: i * 100,
          site: `collect${i + 1}`,
        });
      }

      const results = await engine.collectResults();

      expect(results).not.toBeNull();
      expect(results?.workerResults).toHaveLength(20);
      expect(results?.completedCount).toBe(20);
      expect(results?.failedCount).toBe(0);
      expect(results?.status).toBe('COMPLETED');

      // Verify each worker's data is in results
      for (let i = 0; i < 20; i++) {
        const workerResult = results?.workerResults.find(r => r.workerName === `collect${i + 1}`);
        expect(workerResult).toBeDefined();
        expect(workerResult?.status).toBe('SUCCESS');
        expect((workerResult?.dataExtracted as Record<string, unknown>)?.price).toBe(i * 100);
      }
    });

    test('should handle partial failures across 20 workers', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-partial-20',
        name: 'Partial Failures 20',
        steps: Array.from({ length: 20 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `partial${i + 1}`,
          url: `https://partial${i + 1}.example.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // 15 succeed, 5 fail
      for (let i = 0; i < 15; i++) {
        await engine.completeWorker(`partial${i + 1}`, 'SUCCESS', `Done`, { data: i });
      }
      for (let i = 15; i < 20; i++) {
        await engine.completeWorker(`partial${i + 1}`, 'FAIL', 'Connection error', {});
      }

      const status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('PARTIAL');
      expect(status?.completedWorkers).toBe(15);
      expect(status?.failedWorkers).toBe(5);

      const results = await engine.collectResults();
      expect(results?.workerResults.filter(r => r.status === 'SUCCESS')).toHaveLength(15);
      expect(results?.workerResults.filter(r => r.status === 'FAIL')).toHaveLength(5);
    });
  });

  describe('Memory Efficiency', () => {
    test('should use single session ID shared across all 20 workers', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-session-share-20',
        name: 'Shared Session 20',
        steps: Array.from({ length: 20 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `session${i + 1}`,
          url: `https://session${i + 1}.example.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // All createWorker calls should use the same sessionId
      const createWorkerCalls = mockSessionManager.createWorker.mock.calls;
      expect(createWorkerCalls).toHaveLength(20);

      for (const call of createWorkerCalls) {
        expect(call[0]).toBe(testSessionId);
      }

      // All createTarget calls should use the same sessionId
      const createTargetCalls = mockSessionManager.createTarget.mock.calls;
      expect(createTargetCalls).toHaveLength(20);

      for (const call of createTargetCalls) {
        expect(call[0]).toBe(testSessionId);
      }
    });

    test('should reuse mock session manager across all 20 workers (not create new managers)', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-single-manager-20',
        name: 'Single Manager 20',
        steps: Array.from({ length: 20 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `mgr${i + 1}`,
          url: `https://mgr${i + 1}.example.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Verify the session manager was called exactly 20 times for workers
      // and 20 times for targets — not more (no duplication)
      expect(mockSessionManager.createWorker).toHaveBeenCalledTimes(20);
      expect(mockSessionManager.createTarget).toHaveBeenCalledTimes(20);

      // Verify all workers are stored in the single mock instance
      const workerStore = mockSessionManager.getWorkers();
      expect(workerStore.size).toBe(20);
    });
  });

  describe('Cleanup', () => {
    test('should clean up all 20 workers without leaking state', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-cleanup-20',
        name: 'Cleanup 20',
        steps: Array.from({ length: 20 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `cleanup${i + 1}`,
          url: `https://cleanup${i + 1}.example.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Verify state files exist before cleanup
      const workerPathBefore = stateManager.getWorkerPath('cleanup1');
      expect(fs.existsSync(workerPathBefore)).toBe(true);

      // Cleanup
      await engine.cleanupWorkflow(testSessionId);

      // Verify orchestration state is gone after cleanup
      const status = await engine.getOrchestrationStatus();
      expect(status).toBeNull();

      // Verify deleteWorker was called for all 20 workers
      expect(mockSessionManager.deleteWorker).toHaveBeenCalledTimes(20);
    });

    test('should delete all 20 workers via session manager on cleanup', async () => {
      const workerNames = Array.from({ length: 20 }, (_, i) => `del${i + 1}`);

      const workflow: WorkflowDefinition = {
        id: 'wf-delete-all-20',
        name: 'Delete All 20',
        steps: workerNames.map((name, i) => ({
          workerId: `w${i + 1}`,
          workerName: name,
          url: `https://${name}.example.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);
      await engine.cleanupWorkflow(testSessionId);

      const deleteCalls = mockSessionManager.deleteWorker.mock.calls;
      expect(deleteCalls).toHaveLength(20);

      // All delete calls should use the same sessionId
      for (const call of deleteCalls) {
        expect(call[0]).toBe(testSessionId);
      }
    });
  });

  describe('Scale Boundary', () => {
    test('should handle exactly 20 workers at the boundary limit', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-boundary-20',
        name: 'Boundary 20',
        steps: Array.from({ length: 20 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `boundary${i + 1}`,
          url: `https://boundary${i + 1}.example.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      const { workers } = await engine.initWorkflow(testSessionId, workflow);

      // Exactly 20 workers, no more, no less
      expect(workers.length).toBe(20);
      expect(workers.length).toBeGreaterThanOrEqual(20);
    });

    test('should handle 25 workers to verify capacity beyond 20', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-beyond-20',
        name: 'Beyond 20 Workers',
        steps: Array.from({ length: 25 }, (_, i) => ({
          workerId: `w${i + 1}`,
          workerName: `beyond${i + 1}`,
          url: `https://beyond${i + 1}.example.com`,
          task: `Task ${i + 1}`,
          successCriteria: 'Done',
        })),
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      const { workers } = await engine.initWorkflow(testSessionId, workflow);

      expect(workers).toHaveLength(25);

      // Complete all 25
      for (let i = 0; i < 25; i++) {
        await engine.completeWorker(`beyond${i + 1}`, 'SUCCESS', `Done ${i + 1}`, { i });
      }

      const status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('COMPLETED');
      expect(status?.completedWorkers).toBe(25);

      const results = await engine.collectResults();
      expect(results?.workerResults).toHaveLength(25);
    });
  });
});
