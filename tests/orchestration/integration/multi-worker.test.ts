/// <reference types="jest" />
/**
 * Integration tests for multi-worker coordination
 * Tests parallel worker execution and state isolation
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

describe('Multi-Worker Coordination Integration', () => {
  let engine: WorkflowEngine;
  let stateManager: OrchestrationStateManager;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  const testDir = '.agent/test-multi-worker';
  const testSessionId = 'test-session-multi';

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

  describe('Parallel Worker Completion', () => {
    test('should handle 10 workers completing in parallel', async () => {
      const steps = Array.from({ length: 10 }, (_, i) => ({
        workerId: `w${i + 1}`,
        workerName: `worker${i + 1}`,
        url: `https://site${i + 1}.com`,
        task: `Task ${i + 1}`,
        successCriteria: 'Done',
      }));

      const workflow: WorkflowDefinition = {
        id: 'wf-parallel-10',
        name: 'Parallel 10 Workers',
        steps,
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      const { workers } = await engine.initWorkflow(testSessionId, workflow);
      expect(workers).toHaveLength(10);

      // Complete all workers in parallel
      const completions = workers.map((w, i) =>
        engine.completeWorker(w.workerName, 'SUCCESS', `Done ${i + 1}`, { index: i })
      );
      await Promise.all(completions);

      const status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('COMPLETED');
      expect(status?.completedWorkers).toBe(10);
    });

    test('should handle mixed parallel completions', async () => {
      const steps = Array.from({ length: 5 }, (_, i) => ({
        workerId: `w${i + 1}`,
        workerName: `worker${i + 1}`,
        url: `https://site${i + 1}.com`,
        task: `Task ${i + 1}`,
        successCriteria: 'Done',
      }));

      const workflow: WorkflowDefinition = {
        id: 'wf-mixed-parallel',
        name: 'Mixed Parallel',
        steps,
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Complete with different statuses in parallel
      await Promise.all([
        engine.completeWorker('worker1', 'SUCCESS', 'Done', {}),
        engine.completeWorker('worker2', 'PARTIAL', 'Partial', {}),
        engine.completeWorker('worker3', 'FAIL', 'Failed', {}),
        engine.completeWorker('worker4', 'SUCCESS', 'Done', {}),
        engine.completeWorker('worker5', 'PARTIAL', 'Partial', {}),
      ]);

      const status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('PARTIAL');
      expect(status?.completedWorkers).toBe(4); // SUCCESS + PARTIAL
      expect(status?.failedWorkers).toBe(1);
    });
  });

  describe('Worker State Isolation', () => {
    test('should maintain independent progress logs per worker', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-isolation',
        name: 'Isolation Test',
        steps: [
          { workerId: 'w1', workerName: 'worker1', url: 'https://site1.com', task: 'Task 1', successCriteria: 'Done' },
          { workerId: 'w2', workerName: 'worker2', url: 'https://site2.com', task: 'Task 2', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Add different progress entries to each worker
      await engine.updateWorkerProgress('worker1', {
        action: 'Navigate to Google',
        result: 'SUCCESS',
      });
      await engine.updateWorkerProgress('worker1', {
        action: 'Search',
        result: 'SUCCESS',
      });

      await engine.updateWorkerProgress('worker2', {
        action: 'Navigate to Amazon',
        result: 'SUCCESS',
      });
      await engine.updateWorkerProgress('worker2', {
        action: 'Browse',
        result: 'FAIL',
        error: 'Page not found',
      });
      await engine.updateWorkerProgress('worker2', {
        action: 'Retry',
        result: 'SUCCESS',
      });

      // Verify isolation
      const state1 = await engine.getWorkerState('worker1');
      const state2 = await engine.getWorkerState('worker2');

      expect(state1?.progressLog).toHaveLength(2);
      expect(state2?.progressLog).toHaveLength(3);

      expect(state1?.progressLog[0].action).toBe('Navigate to Google');
      expect(state2?.progressLog[0].action).toBe('Navigate to Amazon');

      // Check error is only in worker2
      expect(state1?.progressLog.some(p => p.error)).toBe(false);
      expect(state2?.progressLog.some(p => p.error)).toBe(true);
    });

    test('should maintain independent extracted data per worker', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-data-isolation',
        name: 'Data Isolation Test',
        steps: [
          { workerId: 'w1', workerName: 'google', url: 'https://google.com', task: 'Search', successCriteria: 'Done' },
          { workerId: 'w2', workerName: 'naver', url: 'https://naver.com', task: 'Search', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Complete with different extracted data
      await engine.completeWorker('google', 'SUCCESS', 'Found 100 results', {
        results: 100,
        source: 'google',
        items: ['a', 'b', 'c'],
      });

      await engine.completeWorker('naver', 'SUCCESS', 'Found 50 results', {
        results: 50,
        source: 'naver',
        items: ['x', 'y'],
      });

      const googleState = await engine.getWorkerState('google');
      const naverState = await engine.getWorkerState('naver');

      expect(googleState?.extractedData).toEqual({
        results: 100,
        source: 'google',
        items: ['a', 'b', 'c'],
      });

      expect(naverState?.extractedData).toEqual({
        results: 50,
        source: 'naver',
        items: ['x', 'y'],
      });
    });

    test('should create separate scratchpad files per worker', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-files',
        name: 'Files Test',
        steps: [
          { workerId: 'w1', workerName: 'site1', url: 'https://site1.com', task: 'Task 1', successCriteria: 'Done' },
          { workerId: 'w2', workerName: 'site2', url: 'https://site2.com', task: 'Task 2', successCriteria: 'Done' },
          { workerId: 'w3', workerName: 'site3', url: 'https://site3.com', task: 'Task 3', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Verify separate files exist
      expect(fs.existsSync(stateManager.getWorkerPath('site1'))).toBe(true);
      expect(fs.existsSync(stateManager.getWorkerPath('site2'))).toBe(true);
      expect(fs.existsSync(stateManager.getWorkerPath('site3'))).toBe(true);

      // Verify files have different content
      const content1 = fs.readFileSync(stateManager.getWorkerPath('site1'), 'utf-8');
      const content2 = fs.readFileSync(stateManager.getWorkerPath('site2'), 'utf-8');

      expect(content1).toContain('site1');
      expect(content2).toContain('site2');
      expect(content1).not.toContain('site2');
    });
  });

  describe('Worker Status Transitions', () => {
    test('should track status transitions independently', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-transitions',
        name: 'Transitions Test',
        steps: [
          { workerId: 'w1', workerName: 'fast', url: 'https://fast.com', task: 'Fast task', successCriteria: 'Done' },
          { workerId: 'w2', workerName: 'slow', url: 'https://slow.com', task: 'Slow task', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Fast worker completes quickly
      await engine.updateWorkerProgress('fast', { status: 'IN_PROGRESS' });
      await engine.completeWorker('fast', 'SUCCESS', 'Done fast', {});

      // Slow worker still in progress
      await engine.updateWorkerProgress('slow', { status: 'IN_PROGRESS' });

      // Verify different statuses
      const fastState = await engine.getWorkerState('fast');
      const slowState = await engine.getWorkerState('slow');

      expect(fastState?.status).toBe('SUCCESS');
      expect(slowState?.status).toBe('IN_PROGRESS');

      // Orchestration should be RUNNING
      const status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('RUNNING');
      expect(status?.completedWorkers).toBe(1);
    });

    test('should update orchestration status correctly as workers complete', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-orch-status',
        name: 'Orchestration Status Test',
        steps: [
          { workerId: 'w1', workerName: 'w1', url: 'https://w1.com', task: 'Task 1', successCriteria: 'Done' },
          { workerId: 'w2', workerName: 'w2', url: 'https://w2.com', task: 'Task 2', successCriteria: 'Done' },
          { workerId: 'w3', workerName: 'w3', url: 'https://w3.com', task: 'Task 3', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Initially INIT
      let status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('INIT');

      // After first completion
      await engine.completeWorker('w1', 'SUCCESS', 'Done', {});
      status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('RUNNING');

      // After second completion
      await engine.completeWorker('w2', 'SUCCESS', 'Done', {});
      status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('RUNNING');

      // After all complete
      await engine.completeWorker('w3', 'SUCCESS', 'Done', {});
      status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('COMPLETED');
    });
  });

  describe('Result Aggregation', () => {
    test('should aggregate results from all workers correctly', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-aggregate',
        name: 'Aggregation Test',
        steps: [
          { workerId: 'w1', workerName: 'coupang', url: 'https://coupang.com', task: 'Price check', successCriteria: 'Done' },
          { workerId: 'w2', workerName: '11st', url: 'https://11st.co.kr', task: 'Price check', successCriteria: 'Done' },
          { workerId: 'w3', workerName: 'gmarket', url: 'https://gmarket.com', task: 'Price check', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Complete with different data
      await engine.completeWorker('coupang', 'SUCCESS', 'Found price', { price: 1200000, url: 'https://coupang.com/item1' });
      await engine.completeWorker('11st', 'SUCCESS', 'Found price', { price: 1180000, url: 'https://11st.co.kr/item1' });
      await engine.completeWorker('gmarket', 'PARTIAL', 'Price range', { minPrice: 1150000, maxPrice: 1250000 });

      const results = await engine.collectResults();

      expect(results?.workerResults).toHaveLength(3);
      expect(results?.completedCount).toBe(3);

      // Find specific results
      const coupangResult = results?.workerResults.find(r => r.workerName === 'coupang');
      expect(coupangResult?.dataExtracted).toEqual({ price: 1200000, url: 'https://coupang.com/item1' });

      const gmarketResult = results?.workerResults.find(r => r.workerName === 'gmarket');
      expect(gmarketResult?.status).toBe('PARTIAL');
    });

    test('should include iteration counts in results', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-iterations',
        name: 'Iterations Test',
        steps: [
          { workerId: 'w1', workerName: 'w1', url: 'https://w1.com', task: 'Task', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Simulate multiple iterations
      for (let i = 1; i <= 4; i++) {
        await engine.updateWorkerProgress('w1', {
          iteration: i,
          action: `Iteration ${i}`,
          result: 'IN_PROGRESS',
        });
      }
      await engine.updateWorkerProgress('w1', { iteration: 4 });
      await engine.completeWorker('w1', 'SUCCESS', 'Done after 4 iterations', {});

      const results = await engine.collectResults();
      expect(results?.workerResults[0].iterations).toBe(4);
    });
  });

  describe('Partial Failure Handling', () => {
    test('should continue with remaining workers after one fails', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-partial-fail',
        name: 'Partial Failure Test',
        steps: [
          { workerId: 'w1', workerName: 'reliable', url: 'https://reliable.com', task: 'Task', successCriteria: 'Done' },
          { workerId: 'w2', workerName: 'flaky', url: 'https://flaky.com', task: 'Task', successCriteria: 'Done' },
          { workerId: 'w3', workerName: 'stable', url: 'https://stable.com', task: 'Task', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      // Flaky worker fails early
      await engine.completeWorker('flaky', 'FAIL', 'Connection error', {});

      // Verify other workers can still complete
      await engine.completeWorker('reliable', 'SUCCESS', 'Done', { data: 'reliable' });
      await engine.completeWorker('stable', 'SUCCESS', 'Done', { data: 'stable' });

      const status = await engine.getOrchestrationStatus();
      expect(status?.status).toBe('PARTIAL');
      expect(status?.completedWorkers).toBe(2);
      expect(status?.failedWorkers).toBe(1);

      // Results should include both successes and failure
      const results = await engine.collectResults();
      expect(results?.workerResults.filter(r => r.status === 'SUCCESS')).toHaveLength(2);
      expect(results?.workerResults.filter(r => r.status === 'FAIL')).toHaveLength(1);
    });
  });
});
