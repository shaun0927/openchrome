/// <reference types="jest" />
/**
 * Integration tests for complete workflow lifecycle
 * Tests the full flow: init → update → complete → collect → cleanup
 */

import * as fs from 'fs';
import * as path from 'path';
import { WorkflowEngine, WorkflowDefinition } from '../../../src/orchestration/workflow-engine';
import { OrchestrationStateManager } from '../../../src/orchestration/state-manager';
import { createMockSessionManager } from '../../mocks/orchestration-fixtures';

// Mock the session manager
jest.mock('../../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../../src/session-manager';

describe('Workflow Lifecycle Integration', () => {
  let engine: WorkflowEngine;
  let stateManager: OrchestrationStateManager;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  const testDir = '.agent/test-lifecycle';
  const testSessionId = 'test-session-lifecycle';

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);

    stateManager = new OrchestrationStateManager(testDir);
    await stateManager.cleanup();

    engine = new WorkflowEngine();
    // @ts-expect-error - accessing private property for testing
    engine.stateManager = stateManager;
    // @ts-expect-error - accessing private property for testing
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

  describe('Complete Lifecycle: init → update → complete → collect → cleanup', () => {
    test('should complete full workflow lifecycle successfully', async () => {
      // 1. Initialize workflow
      const workflow: WorkflowDefinition = {
        id: 'wf-lifecycle',
        name: 'Lifecycle Test',
        steps: [
          { workerId: 'w1', workerName: 'google', url: 'https://google.com', task: 'Search', successCriteria: 'Results shown' },
          { workerId: 'w2', workerName: 'naver', url: 'https://naver.com', task: 'Browse', successCriteria: 'Page loaded' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      const { orchestrationId, workers } = await engine.initWorkflow(testSessionId, workflow);

      expect(orchestrationId).toBeDefined();
      expect(workers).toHaveLength(2);

      // Verify initial state
      const initialStatus = await engine.getOrchestrationStatus();
      expect(initialStatus?.status).toBe('INIT');
      expect(initialStatus?.completedWorkers).toBe(0);

      // 2. Update worker progress
      for (const worker of workers) {
        await engine.updateWorkerProgress(worker.workerName, {
          status: 'IN_PROGRESS',
          iteration: 1,
          action: 'Navigate',
          result: 'SUCCESS',
        });
      }

      // Verify progress state
      const progressState = await engine.getWorkerState('google');
      expect(progressState?.status).toBe('IN_PROGRESS');
      expect(progressState?.progressLog).toHaveLength(1);

      // 3. Complete workers
      await engine.completeWorker('google', 'SUCCESS', 'Search completed', { results: 10 });
      await engine.completeWorker('naver', 'SUCCESS', 'Browse completed', { pages: 5 });

      // Verify completed state
      const completedStatus = await engine.getOrchestrationStatus();
      expect(completedStatus?.status).toBe('COMPLETED');
      expect(completedStatus?.completedWorkers).toBe(2);
      expect(completedStatus?.failedWorkers).toBe(0);

      // 4. Collect results
      const results = await engine.collectResults();
      expect(results).not.toBeNull();
      expect(results?.status).toBe('COMPLETED');
      expect(results?.workerResults).toHaveLength(2);
      expect(results?.completedCount).toBe(2);
      expect(results?.failedCount).toBe(0);
      expect(results?.duration).toBeGreaterThan(0);

      // Verify extracted data
      const googleResult = results?.workerResults.find(r => r.workerName === 'google');
      expect(googleResult?.dataExtracted).toEqual({ results: 10 });

      // 5. Cleanup
      await engine.cleanupWorkflow(testSessionId);

      // Verify cleanup
      expect(mockSessionManager.deleteWorker).toHaveBeenCalledTimes(2);
      const postCleanupStatus = await engine.getOrchestrationStatus();
      expect(postCleanupStatus).toBeNull();
    });

    test('should handle workflow with worker failures', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-failures',
        name: 'Failure Test',
        steps: [
          { workerId: 'w1', workerName: 'success-worker', url: 'https://success.com', task: 'Pass', successCriteria: 'Done' },
          { workerId: 'w2', workerName: 'fail-worker', url: 'https://fail.com', task: 'Fail', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Simulate worker execution
      await engine.updateWorkerProgress('success-worker', {
        status: 'IN_PROGRESS',
        action: 'Navigate',
        result: 'SUCCESS',
      });

      await engine.updateWorkerProgress('fail-worker', {
        status: 'IN_PROGRESS',
        action: 'Navigate',
        result: 'FAIL',
        error: 'Connection timeout',
      });

      // Complete workers
      await engine.completeWorker('success-worker', 'SUCCESS', 'Task completed', { data: 'ok' });
      await engine.completeWorker('fail-worker', 'FAIL', 'Task failed', {});

      // Verify partial status
      const status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('PARTIAL');
      expect(status?.completedWorkers).toBe(1);
      expect(status?.failedWorkers).toBe(1);

      // Collect results
      const results = await engine.collectResults();
      expect(results?.status).toBe('PARTIAL');
      expect(results?.completedCount).toBe(1);
      expect(results?.failedCount).toBe(1);

      // Verify error information
      const failedResult = results?.workerResults.find(r => r.workerName === 'fail-worker');
      expect(failedResult?.status).toBe('FAIL');
    });

    test('should handle all workers failing', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-all-fail',
        name: 'All Fail Test',
        steps: [
          { workerId: 'w1', workerName: 'fail1', url: 'https://fail1.com', task: 'Fail 1', successCriteria: 'Done' },
          { workerId: 'w2', workerName: 'fail2', url: 'https://fail2.com', task: 'Fail 2', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      await engine.completeWorker('fail1', 'FAIL', 'Error 1', {});
      await engine.completeWorker('fail2', 'FAIL', 'Error 2', {});

      const status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('FAILED');
      expect(status?.failedWorkers).toBe(2);

      const results = await engine.collectResults();
      expect(results?.status).toBe('FAILED');
      expect(results?.failedCount).toBe(2);
    });

    test('should handle mixed SUCCESS and PARTIAL results', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-mixed',
        name: 'Mixed Results Test',
        steps: [
          { workerId: 'w1', workerName: 'full', url: 'https://full.com', task: 'Full', successCriteria: 'Done' },
          { workerId: 'w2', workerName: 'partial', url: 'https://partial.com', task: 'Partial', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      await engine.completeWorker('full', 'SUCCESS', 'Fully done', { items: 10 });
      await engine.completeWorker('partial', 'PARTIAL', 'Partially done', { items: 5 });

      const status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('COMPLETED');
      expect(status?.completedWorkers).toBe(2); // Both SUCCESS and PARTIAL count as completed

      const results = await engine.collectResults();
      expect(results?.completedCount).toBe(2);
    });
  });

  describe('Process Recovery', () => {
    test('should recover state after partial completion', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-recovery',
        name: 'Recovery Test',
        steps: [
          { workerId: 'w1', workerName: 'worker1', url: 'https://site1.com', task: 'Task 1', successCriteria: 'Done' },
          { workerId: 'w2', workerName: 'worker2', url: 'https://site2.com', task: 'Task 2', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      // Initialize and partially complete
      await engine.initWorkflow(testSessionId, workflow);
      await engine.completeWorker('worker1', 'SUCCESS', 'Done 1', { data: 'A' });

      // Simulate "process restart" by creating a new engine instance that reads from same state
      const newEngine = new WorkflowEngine();
      // @ts-expect-error
      newEngine.stateManager = stateManager;
      // @ts-expect-error
      newEngine.sessionManager = mockSessionManager;

      // Verify state is preserved
      const recoveredStatus = await newEngine.getOrchestrationStatus();
      expect(recoveredStatus?.completedWorkers).toBe(1);
      expect(recoveredStatus?.workers.find(w => w.workerName === 'worker1')?.status).toBe('SUCCESS');

      // Complete remaining work
      await newEngine.completeWorker('worker2', 'SUCCESS', 'Done 2', { data: 'B' });

      const finalStatus = await newEngine.getOrchestrationStatus();
      expect(finalStatus?.status).toBe('COMPLETED');
      expect(finalStatus?.completedWorkers).toBe(2);
    });

    test('should read worker progress from existing scratchpad', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-scratchpad',
        name: 'Scratchpad Test',
        steps: [
          { workerId: 'w1', workerName: 'test', url: 'https://test.com', task: 'Task', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Add multiple progress entries
      for (let i = 0; i < 5; i++) {
        await engine.updateWorkerProgress('test', {
          iteration: i + 1,
          action: `Action ${i + 1}`,
          result: 'SUCCESS',
        });
      }

      // Create new engine and verify progress is readable
      const newEngine = new WorkflowEngine();
      // @ts-expect-error
      newEngine.stateManager = stateManager;

      const workerState = await newEngine.getWorkerState('test');
      expect(workerState?.progressLog).toHaveLength(5);
    });
  });

  describe('Edge Cases', () => {
    test('should handle single worker workflow', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-single',
        name: 'Single Worker',
        steps: [
          { workerId: 'w1', workerName: 'solo', url: 'https://solo.com', task: 'Solo task', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      const { workers } = await engine.initWorkflow(testSessionId, workflow);
      expect(workers).toHaveLength(1);

      await engine.completeWorker('solo', 'SUCCESS', 'Done', { result: 'ok' });

      const status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('COMPLETED');
    });

    test('should handle rapid sequential updates', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-rapid',
        name: 'Rapid Updates',
        steps: [
          { workerId: 'w1', workerName: 'rapid', url: 'https://rapid.com', task: 'Rapid task', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Rapid sequential updates
      for (let i = 0; i < 20; i++) {
        await engine.updateWorkerProgress('rapid', {
          iteration: i,
          action: `Action ${i}`,
          result: 'SUCCESS',
        });
      }

      const state = await engine.getWorkerState('rapid');
      expect(state?.progressLog.length).toBeGreaterThan(0);
    });

    test('should handle empty task description', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-empty',
        name: 'Empty Task',
        steps: [
          { workerId: 'w1', workerName: 'empty', url: 'https://empty.com', task: '', successCriteria: '' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      const { workers } = await engine.initWorkflow(testSessionId, workflow);
      expect(workers).toHaveLength(1);

      await engine.completeWorker('empty', 'SUCCESS', '', {});

      const status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('COMPLETED');
    });
  });
});
