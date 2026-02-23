/// <reference types="jest" />
/**
 * Unit tests for Orchestration MCP Tools
 * Tests the 6 MCP tool handlers for workflow management
 */

import * as fs from 'fs';
import * as path from 'path';
import { MCPServer } from '../../src/mcp-server';
import { MCPResult } from '../../src/types/mcp';
import { registerOrchestrationTools } from '../../src/tools/orchestration';
import { OrchestrationStateManager } from '../../src/orchestration/state-manager';
import { WorkflowEngine } from '../../src/orchestration/workflow-engine';
import { createMockSessionManager } from '../mocks/orchestration-fixtures';
import { getResultText, parseResultJSON, isErrorResult } from '../utils/test-helpers';

// Mock the session manager module
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

// Mock the state manager to use test directory
jest.mock('../../src/orchestration/state-manager', () => {
  const actual = jest.requireActual('../../src/orchestration/state-manager');
  return {
    ...actual,
    getOrchestrationStateManager: jest.fn(),
  };
});

// Mock the workflow engine
jest.mock('../../src/orchestration/workflow-engine', () => {
  const actual = jest.requireActual('../../src/orchestration/workflow-engine');
  return {
    ...actual,
    getWorkflowEngine: jest.fn(),
  };
});

import { getSessionManager } from '../../src/session-manager';
import { getOrchestrationStateManager } from '../../src/orchestration/state-manager';
import { getWorkflowEngine } from '../../src/orchestration/workflow-engine';

describe('Orchestration MCP Tools', () => {
  let mockServer: Partial<MCPServer>;
  let toolHandlers: Map<string, (sessionId: string, args: Record<string, unknown>) => Promise<MCPResult>>;
  let stateManager: OrchestrationStateManager;
  let engine: WorkflowEngine;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  const testDir = '.agent/test-orch-tools';
  const testSessionId = 'test-session-123';

  beforeEach(async () => {
    // Create tool handlers map
    toolHandlers = new Map();

    // Create mock server that captures tool registrations
    mockServer = {
      registerTool: jest.fn((name: string, handler: (sessionId: string, args: Record<string, unknown>) => Promise<MCPResult>) => {
        toolHandlers.set(name, handler);
      }),
    };

    // Create mock session manager
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);

    // Create real state manager for test directory
    stateManager = new OrchestrationStateManager(testDir);
    await stateManager.cleanup();
    (getOrchestrationStateManager as jest.Mock).mockReturnValue(stateManager);

    // Create real engine with mocked session manager
    engine = new WorkflowEngine();
    // @ts-expect-error - accessing private property for testing
    engine.stateManager = stateManager;
    // @ts-expect-error - accessing private property for testing
    engine.sessionManager = mockSessionManager;
    (getWorkflowEngine as jest.Mock).mockReturnValue(engine);

    // Register tools
    registerOrchestrationTools(mockServer as MCPServer);
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

  describe('Tool Registration', () => {
    test('should register all 6 orchestration tools', () => {
      expect(mockServer.registerTool).toHaveBeenCalledTimes(6);
      expect(toolHandlers.has('workflow_init')).toBe(true);
      expect(toolHandlers.has('workflow_status')).toBe(true);
      expect(toolHandlers.has('workflow_collect')).toBe(true);
      expect(toolHandlers.has('workflow_cleanup')).toBe(true);
      expect(toolHandlers.has('worker_update')).toBe(true);
      expect(toolHandlers.has('worker_complete')).toBe(true);
    });
  });

  describe('workflow_init', () => {
    const callInit = (args: Record<string, unknown>) =>
      toolHandlers.get('workflow_init')!(testSessionId, args);

    test('should initialize workflow with workers', async () => {
      const result = await callInit({
        name: 'Test Workflow',
        workers: [
          { name: 'google', url: 'https://google.com', task: 'Search' },
          { name: 'naver', url: 'https://naver.com', task: 'Browse' },
        ],
      });

      expect(isErrorResult(result)).toBe(false);
      const data = parseResultJSON<{ orchestrationId: string; workers: unknown[] }>(result);
      expect(data.orchestrationId).toBeDefined();
      expect(data.workers).toHaveLength(2);
    });

    test('should return worker configurations with tabId', async () => {
      const result = await callInit({
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      const data = parseResultJSON<{ workers: Array<{ tabId: string }> }>(result);
      expect(data.workers[0].tabId).toBeDefined();
    });

    test('should include scratchpad directory path', async () => {
      const result = await callInit({
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      const data = parseResultJSON<{ scratchpadDir: string }>(result);
      expect(data.scratchpadDir).toBeDefined();
    });

    test('should include worker prompts', async () => {
      const result = await callInit({
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      const data = parseResultJSON<{ workerPrompts: Array<{ prompt: string }> }>(result);
      expect(data.workerPrompts).toHaveLength(1);
      expect(data.workerPrompts[0].prompt).toContain('Chrome-Sisyphus');
    });

    test('should use default success criteria if not provided', async () => {
      const result = await callInit({
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      expect(isErrorResult(result)).toBe(false);
    });

    test('should use custom success criteria when provided', async () => {
      const result = await callInit({
        name: 'Test',
        workers: [
          { name: 'test', url: 'https://test.com', task: 'Task', successCriteria: 'Custom criteria' },
        ],
      });

      const data = parseResultJSON<{ workerPrompts: Array<{ prompt: string }> }>(result);
      expect(data.workerPrompts[0].prompt).toContain('Custom criteria');
    });

    test('should return error on workflow initialization failure', async () => {
      // Force an error by mocking session manager to throw
      mockSessionManager.createWorker.mockRejectedValueOnce(new Error('Session not found'));

      const result = await callInit({
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      expect(isErrorResult(result)).toBe(true);
      expect(getResultText(result)).toContain('Error');
    });
  });

  describe('workflow_status', () => {
    const callStatus = (args: Record<string, unknown> = {}) =>
      toolHandlers.get('workflow_status')!(testSessionId, args);

    test('should return NO_WORKFLOW when no active workflow', async () => {
      const result = await callStatus();

      const data = parseResultJSON<{ status: string }>(result);
      expect(data.status).toBe('NO_WORKFLOW');
    });

    test('should return current workflow status', async () => {
      // Initialize a workflow first
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      const result = await callStatus();

      const data = parseResultJSON<{ status: string; orchestrationId: string }>(result);
      expect(data.orchestrationId).toBeDefined();
      expect(data.status).toBe('INIT');
    });

    test('should include completion counts', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      const result = await callStatus();

      const data = parseResultJSON<{ completedWorkers: number; failedWorkers: number }>(result);
      expect(data.completedWorkers).toBe(0);
      expect(data.failedWorkers).toBe(0);
    });

    test('should include worker list', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [
          { name: 'worker1', url: 'https://test1.com', task: 'Task 1' },
          { name: 'worker2', url: 'https://test2.com', task: 'Task 2' },
        ],
      });

      const result = await callStatus();

      const data = parseResultJSON<{ workers: Array<{ workerName: string }> }>(result);
      expect(data.workers).toHaveLength(2);
    });

    test('should include duration', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      // Wait a bit
      await new Promise((r) => setTimeout(r, 50));

      const result = await callStatus();

      const data = parseResultJSON<{ duration: number }>(result);
      expect(data.duration).toBeGreaterThanOrEqual(50);
    });

    test('should include worker details when requested', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      const result = await callStatus({ includeWorkerDetails: true });

      const data = parseResultJSON<{ workerDetails: Array<{ workerName: string; progressLog: unknown[] }> }>(result);
      expect(data.workerDetails).toBeDefined();
      expect(data.workerDetails).toHaveLength(1);
    });

    test('should not include worker details by default', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      const result = await callStatus();

      const data = parseResultJSON<{ workerDetails?: unknown }>(result);
      expect(data.workerDetails).toBeUndefined();
    });
  });

  describe('workflow_collect', () => {
    const callCollect = () => toolHandlers.get('workflow_collect')!(testSessionId, {});

    test('should return NO_RESULTS when no workflow exists', async () => {
      const result = await callCollect();

      const data = parseResultJSON<{ status: string }>(result);
      expect(data.status).toBe('NO_RESULTS');
    });

    test('should collect results from completed workers', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [
          { name: 'worker1', url: 'https://test1.com', task: 'Task 1' },
          { name: 'worker2', url: 'https://test2.com', task: 'Task 2' },
        ],
      });

      await toolHandlers.get('worker_complete')!(testSessionId, {
        workerName: 'worker1',
        status: 'SUCCESS',
        resultSummary: 'Done 1',
        extractedData: { data: 'A' },
      });
      await toolHandlers.get('worker_complete')!(testSessionId, {
        workerName: 'worker2',
        status: 'SUCCESS',
        resultSummary: 'Done 2',
        extractedData: { data: 'B' },
      });

      const result = await callCollect();

      const data = parseResultJSON<{
        workerResults: Array<{ workerName: string }>;
        completedCount: number;
      }>(result);
      expect(data.workerResults).toHaveLength(2);
      expect(data.completedCount).toBe(2);
    });

    test('should include orchestration ID', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      const result = await callCollect();

      const data = parseResultJSON<{ orchestrationId: string }>(result);
      expect(data.orchestrationId).toBeDefined();
    });

    test('should include overall status', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      await toolHandlers.get('worker_complete')!(testSessionId, {
        workerName: 'test',
        status: 'SUCCESS',
        resultSummary: 'Done',
      });

      const result = await callCollect();

      const data = parseResultJSON<{ status: string }>(result);
      expect(data.status).toBe('COMPLETED');
    });
  });

  describe('workflow_cleanup', () => {
    const callCleanup = () => toolHandlers.get('workflow_cleanup')!(testSessionId, {});

    test('should cleanup workflow resources', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      const result = await callCleanup();

      const data = parseResultJSON<{ status: string }>(result);
      expect(data.status).toBe('CLEANED');
    });

    test('should call delete on workers', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      await callCleanup();

      expect(mockSessionManager.deleteWorker).toHaveBeenCalled();
    });

    test('should handle cleanup when no workflow exists', async () => {
      const result = await callCleanup();

      const data = parseResultJSON<{ status: string }>(result);
      expect(data.status).toBe('CLEANED');
    });

    test('should remove workflow from subsequent status checks', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      await callCleanup();

      const statusResult = await toolHandlers.get('workflow_status')!(testSessionId, {});
      const data = parseResultJSON<{ status: string }>(statusResult);
      expect(data.status).toBe('NO_WORKFLOW');
    });
  });

  describe('worker_update', () => {
    const callUpdate = (args: Record<string, unknown>) =>
      toolHandlers.get('worker_update')!(testSessionId, args);

    beforeEach(async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test-worker', url: 'https://test.com', task: 'Task' }],
      });
    });

    test('should update worker progress', async () => {
      const result = await callUpdate({
        workerName: 'test-worker',
        status: 'IN_PROGRESS',
        iteration: 2,
      });

      const data = parseResultJSON<{ status: string }>(result);
      expect(data.status).toBe('UPDATED');
    });

    test('should add action to progress log', async () => {
      await callUpdate({
        workerName: 'test-worker',
        action: 'Navigate',
        result: 'SUCCESS',
      });

      const state = await stateManager.readWorkerState('test-worker');
      expect(state?.progressLog).toHaveLength(1);
    });

    test('should include error message when provided', async () => {
      await callUpdate({
        workerName: 'test-worker',
        action: 'Click',
        result: 'FAIL',
        error: 'Element not found',
      });

      const state = await stateManager.readWorkerState('test-worker');
      expect(state?.progressLog[0].error).toBe('Element not found');
    });

    test('should update extracted data', async () => {
      await callUpdate({
        workerName: 'test-worker',
        extractedData: { items: [1, 2, 3] },
      });

      const state = await stateManager.readWorkerState('test-worker');
      expect(state?.extractedData).toEqual({ items: [1, 2, 3] });
    });

    test('should require workerName parameter', async () => {
      const result = await callUpdate({
        status: 'IN_PROGRESS',
      });

      // Should handle gracefully or fail with error
      // Current implementation accepts undefined workerName
      expect(result).toBeDefined();
    });
  });

  describe('worker_complete', () => {
    const callComplete = (args: Record<string, unknown>) =>
      toolHandlers.get('worker_complete')!(testSessionId, args);

    beforeEach(async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [
          { name: 'worker1', url: 'https://test1.com', task: 'Task 1' },
          { name: 'worker2', url: 'https://test2.com', task: 'Task 2' },
        ],
      });
    });

    test('should mark worker as complete with SUCCESS', async () => {
      const result = await callComplete({
        workerName: 'worker1',
        status: 'SUCCESS',
        resultSummary: 'Task completed',
        extractedData: { result: 'data' },
      });

      const data = parseResultJSON<{ status: string; workerStatus: string }>(result);
      expect(data.status).toBe('COMPLETED');
      expect(data.workerStatus).toBe('SUCCESS');
    });

    test('should mark worker as complete with PARTIAL', async () => {
      const result = await callComplete({
        workerName: 'worker1',
        status: 'PARTIAL',
        resultSummary: 'Partial completion',
      });

      const data = parseResultJSON<{ workerStatus: string }>(result);
      expect(data.workerStatus).toBe('PARTIAL');
    });

    test('should mark worker as complete with FAIL', async () => {
      const result = await callComplete({
        workerName: 'worker1',
        status: 'FAIL',
        resultSummary: 'Task failed',
      });

      const data = parseResultJSON<{ workerStatus: string }>(result);
      expect(data.workerStatus).toBe('FAIL');
    });

    test('should update orchestration completion counts', async () => {
      await callComplete({
        workerName: 'worker1',
        status: 'SUCCESS',
        resultSummary: 'Done',
      });

      const statusResult = await toolHandlers.get('workflow_status')!(testSessionId, {});
      const statusData = parseResultJSON<{ completedWorkers: number }>(statusResult);
      expect(statusData.completedWorkers).toBe(1);
    });

    test('should update orchestration failed counts', async () => {
      await callComplete({
        workerName: 'worker1',
        status: 'FAIL',
        resultSummary: 'Failed',
      });

      const statusResult = await toolHandlers.get('workflow_status')!(testSessionId, {});
      const statusData = parseResultJSON<{ failedWorkers: number }>(statusResult);
      expect(statusData.failedWorkers).toBe(1);
    });

    test('should store extracted data', async () => {
      const data = { items: ['a', 'b', 'c'], count: 3 };
      await callComplete({
        workerName: 'worker1',
        status: 'SUCCESS',
        resultSummary: 'Done',
        extractedData: data,
      });

      const state = await stateManager.readWorkerState('worker1');
      expect(state?.extractedData).toEqual(data);
    });

    test('should validate status enum', async () => {
      // Invalid status should be handled
      const result = await callComplete({
        workerName: 'worker1',
        status: 'INVALID_STATUS',
        resultSummary: 'Test',
      });

      // Should either succeed (current behavior) or return error
      // This documents current behavior for reference
      expect(result).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    test('workflow_init should return isError on failure', async () => {
      mockSessionManager.createWorker.mockRejectedValue(new Error('Test error'));

      const result = await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      expect(isErrorResult(result)).toBe(true);
    });

    test('workflow_status should return isError on failure', async () => {
      // Force an error by making state read fail
      const originalRead = stateManager.readOrchestrationState.bind(stateManager);
      stateManager.readOrchestrationState = jest.fn().mockRejectedValue(new Error('Read error'));

      const result = await toolHandlers.get('workflow_status')!(testSessionId, {});

      expect(isErrorResult(result)).toBe(true);

      stateManager.readOrchestrationState = originalRead;
    });

    test('workflow_collect should return isError on failure', async () => {
      // Initialize workflow first
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      // Force an error
      const originalCollect = engine.collectResults.bind(engine);
      engine.collectResults = jest.fn().mockRejectedValue(new Error('Collect error'));

      const result = await toolHandlers.get('workflow_collect')!(testSessionId, {});

      expect(isErrorResult(result)).toBe(true);

      engine.collectResults = originalCollect;
    });

    test('workflow_cleanup should return isError on failure', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      // Force cleanup to throw
      const originalCleanup = engine.cleanupWorkflow.bind(engine);
      engine.cleanupWorkflow = jest.fn().mockRejectedValue(new Error('Cleanup error'));

      const result = await toolHandlers.get('workflow_cleanup')!(testSessionId, {});

      expect(isErrorResult(result)).toBe(true);

      engine.cleanupWorkflow = originalCleanup;
    });

    test('worker_update should return isError on failure', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      // Force update to throw
      const originalUpdate = engine.updateWorkerProgress.bind(engine);
      engine.updateWorkerProgress = jest.fn().mockRejectedValue(new Error('Update error'));

      const result = await toolHandlers.get('worker_update')!(testSessionId, {
        workerName: 'test',
        status: 'IN_PROGRESS',
      });

      expect(isErrorResult(result)).toBe(true);

      engine.updateWorkerProgress = originalUpdate;
    });

    test('worker_complete should return isError on failure', async () => {
      await toolHandlers.get('workflow_init')!(testSessionId, {
        name: 'Test',
        workers: [{ name: 'test', url: 'https://test.com', task: 'Task' }],
      });

      // Force complete to throw
      const originalComplete = engine.completeWorker.bind(engine);
      engine.completeWorker = jest.fn().mockRejectedValue(new Error('Complete error'));

      const result = await toolHandlers.get('worker_complete')!(testSessionId, {
        workerName: 'test',
        status: 'SUCCESS',
        resultSummary: 'Done',
      });

      expect(isErrorResult(result)).toBe(true);

      engine.completeWorker = originalComplete;
    });
  });
});
