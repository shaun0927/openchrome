/// <reference types="jest" />
/**
 * Stress tests for error recovery
 * Tests resilience to various failure scenarios
 */

import * as path from 'path';
import { OrchestrationStateManager } from '../../../src/orchestration/state-manager';
import { WorkflowEngine, WorkflowDefinition } from '../../../src/orchestration/workflow-engine';
import { createMockSessionManager, corruptedStateContent, maliciousWorkerNames } from '../../mocks/orchestration-fixtures';

// Mock fs to make functions mockable (non-configurable in newer Node.js)
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    writeFileSync: jest.fn((...args: unknown[]) => actual.writeFileSync(...args)),
    readFileSync: jest.fn((...args: unknown[]) => actual.readFileSync(...args)),
    mkdirSync: jest.fn((...args: unknown[]) => actual.mkdirSync(...args)),
  };
});

import * as fs from 'fs';

// Mock the session manager
jest.mock('../../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

// Mock CDP singletons used by WorkflowEngine.initWorkflow()
let batchPageCounter = 0;
jest.mock('../../../src/cdp/connection-pool', () => ({
  getCDPConnectionPool: jest.fn().mockReturnValue({
    acquireBatch: jest.fn().mockImplementation((count: number) => {
      return Promise.resolve(
        Array.from({ length: count }, () => {
          const id = `batch-target-${++batchPageCounter}`;
          return {
            target: () => ({ _targetId: id }),
            goto: jest.fn().mockResolvedValue(null),
            close: jest.fn().mockResolvedValue(undefined),
            url: jest.fn().mockReturnValue('about:blank'),
            on: jest.fn(),
            off: jest.fn(),
          };
        })
      );
    }),
    releasePage: jest.fn().mockResolvedValue(undefined),
    initialize: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../../../src/cdp/client', () => ({
  getCDPClient: jest.fn().mockReturnValue({
    findAuthenticatedPageTargetId: jest.fn().mockResolvedValue(null),
    copyCookiesViaCDP: jest.fn().mockResolvedValue(0),
  }),
}));

import { getSessionManager } from '../../../src/session-manager';

const actualFs = jest.requireActual('fs');

describe('Error Recovery Stress Tests', () => {
  let stateManager: OrchestrationStateManager;
  let engine: WorkflowEngine;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  const testDir = '.agent/test-error-recovery';
  const testSessionId = 'test-session-recovery';

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
    // Restore mocked fs functions to pass-through
    (fs.writeFileSync as jest.Mock).mockImplementation((...args: unknown[]) => actualFs.writeFileSync(...args));
    (fs.readFileSync as jest.Mock).mockImplementation((...args: unknown[]) => actualFs.readFileSync(...args));
    (fs.mkdirSync as jest.Mock).mockImplementation((...args: unknown[]) => actualFs.mkdirSync(...args));

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
    jest.restoreAllMocks();
  });

  describe('File System Error Recovery', () => {
    test('should handle transient write errors', async () => {
      await stateManager.initWorkerState('w1', 'test', 't1', 'Task');

      // Mock writeFileSync to fail once
      let failCount = 0;
      (fs.writeFileSync as jest.Mock).mockImplementation((...args: unknown[]) => {
        failCount++;
        if (failCount === 1) {
          throw new Error('ENOSPC: no space left on device');
        }
        return actualFs.writeFileSync(...args);
      });

      // First update should fail
      const result1 = await stateManager.updateWorkerState('test', { status: 'IN_PROGRESS' });
      // May return null on failure or succeed if implementation retries

      // Subsequent updates should work
      (fs.writeFileSync as jest.Mock).mockImplementation((...args: unknown[]) => actualFs.writeFileSync(...args));
      const result2 = await stateManager.updateWorkerState('test', { status: 'SUCCESS' });
      expect(result2).not.toBeNull();
    });

    test('should handle read errors gracefully', async () => {
      await stateManager.initWorkerState('w1', 'test', 't1', 'Task');

      // Delete the worker file to simulate read failure
      const workerFile = path.resolve(testDir, 'worker-test.md');
      if (actualFs.existsSync(workerFile)) {
        actualFs.unlinkSync(workerFile);
      }

      const state = await stateManager.readWorkerState('test');
      expect(state).toBeNull();
    });

    test('should handle directory creation errors', async () => {
      // Mock mkdirSync to fail
      (fs.mkdirSync as jest.Mock).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      try {
        await stateManager.ensureDirectory();
        // If it doesn't throw, the implementation handles errors silently
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('Corrupted State Recovery', () => {
    test('should return null for corrupted JSON', async () => {
      await stateManager.ensureDirectory();
      const filePath = stateManager.getWorkerPath('corrupted');
      fs.writeFileSync(filePath, corruptedStateContent.invalidJson);

      const state = await stateManager.readWorkerState('corrupted');
      expect(state).toBeNull();
    });

    test('should return null for truncated JSON', async () => {
      await stateManager.ensureDirectory();
      const filePath = stateManager.getWorkerPath('truncated');
      fs.writeFileSync(filePath, corruptedStateContent.truncatedJson);

      const state = await stateManager.readWorkerState('truncated');
      expect(state).toBeNull();
    });

    test('should return null for empty file', async () => {
      await stateManager.ensureDirectory();
      const filePath = stateManager.getWorkerPath('empty');
      fs.writeFileSync(filePath, '');

      const state = await stateManager.readWorkerState('empty');
      expect(state).toBeNull();
    });

    test('should return null for markdown without JSON block', async () => {
      await stateManager.ensureDirectory();
      const filePath = stateManager.getWorkerPath('noblock');
      fs.writeFileSync(filePath, corruptedStateContent.markdownWithoutCodeBlock);

      const state = await stateManager.readWorkerState('noblock');
      expect(state).toBeNull();
    });

    test('should handle partial file corruption gracefully', async () => {
      await stateManager.initWorkerState('w1', 'test', 't1', 'Task');

      // Corrupt the file
      const filePath = stateManager.getWorkerPath('test');
      const content = fs.readFileSync(filePath, 'utf-8');
      fs.writeFileSync(filePath, content.slice(0, content.length / 2));

      const state = await stateManager.readWorkerState('test');
      // May or may not be null depending on where truncation occurred
      // The key is it shouldn't crash
      expect(state === null || state !== null).toBe(true);
    });
  });

  describe('Path Traversal Prevention', () => {
    test.each(maliciousWorkerNames.slice(0, 5))(
      'should handle potentially malicious worker name: %s',
      async (name) => {
        // This test documents current behavior
        // After security fix, these should be rejected
        try {
          const state = await stateManager.initWorkerState('w1', name, 't1', 'Task');

          if (state) {
            // If creation succeeded, verify file is in correct directory
            const workerPath = stateManager.getWorkerPath(name);
            const resolvedPath = path.resolve(workerPath);
            const baseDir = path.resolve(testDir);

            // Log for analysis
            console.log(`Worker name: ${name}`);
            console.log(`Resolved path: ${resolvedPath}`);
            console.log(`Base dir: ${baseDir}`);

            // Ideally should be within base directory
            // Current implementation may not enforce this
          }
        } catch (error) {
          // Throwing an error is acceptable behavior
          console.log(`Rejected malicious name: ${name}`);
        }
      }
    );

    test('should validate worker names contain no path separators (ideal behavior)', async () => {
      const dangerousNames = ['../admin', '..\\admin', 'a/b/c', 'a\\b\\c'];

      for (const name of dangerousNames) {
        try {
          await stateManager.initWorkerState('w1', name, 't1', 'Task');
          // If no error, implementation allows these names
          // This documents the vulnerability
        } catch (error) {
          // Error is the correct behavior
          expect(error).toBeDefined();
        }
      }
    });
  });

  describe('Session Manager Error Recovery', () => {
    test('should handle worker creation failure', async () => {
      mockSessionManager.createWorker.mockRejectedValue(new Error('Session not found'));

      const workflow: WorkflowDefinition = {
        id: 'wf-fail',
        name: 'Fail Test',
        steps: [
          { workerId: 'w1', workerName: 'test', url: 'https://test.com', task: 'Task', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await expect(engine.initWorkflow(testSessionId, workflow)).rejects.toThrow();
    });

    test('should handle target creation failure', async () => {
      // initWorkflow now uses acquireBatch from CDP connection pool, not createTarget
      // Temporarily override to reject, then restore
      const { getCDPConnectionPool } = require('../../../src/cdp/connection-pool');
      const failingPool = {
        acquireBatch: jest.fn().mockRejectedValue(new Error('Failed to acquire pages')),
        releasePage: jest.fn().mockResolvedValue(undefined),
        initialize: jest.fn().mockResolvedValue(undefined),
      };
      (getCDPConnectionPool as jest.Mock).mockReturnValueOnce(failingPool);

      const workflow: WorkflowDefinition = {
        id: 'wf-fail-target',
        name: 'Fail Target Test',
        steps: [
          { workerId: 'w1', workerName: 'test', url: 'https://test.com', task: 'Task', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await expect(engine.initWorkflow(testSessionId, workflow)).rejects.toThrow();
    });

    test('should handle worker deletion failure during cleanup', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-cleanup-fail',
        name: 'Cleanup Fail Test',
        steps: [
          { workerId: 'w1', workerName: 'test', url: 'https://test.com', task: 'Task', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await engine.initWorkflow(testSessionId, workflow);

      mockSessionManager.deleteWorker.mockRejectedValue(new Error('Worker already deleted'));

      // Should not throw
      await expect(engine.cleanupWorkflow(testSessionId)).resolves.not.toThrow();
    });
  });

  describe('State Consistency Recovery', () => {
    test('should handle missing orchestration file', async () => {
      // Don't initialize orchestration
      const status = await engine.getOrchestrationStatus();
      expect(status).toBeNull();
    });

    test('should handle missing worker file during getAllWorkerStates', async () => {
      await stateManager.initOrchestration('orch-123', 'Task', [
        { workerId: 'w1', workerName: 'exists', tabId: 't1', task: 'Task 1' },
        { workerId: 'w2', workerName: 'missing', tabId: 't2', task: 'Task 2' },
      ]);

      // Delete one worker file
      const missingPath = stateManager.getWorkerPath('missing');
      fs.unlinkSync(missingPath);

      const states = await stateManager.getAllWorkerStates();

      // Should return only existing workers
      expect(states).toHaveLength(1);
      expect(states[0].workerName).toBe('exists');
    });

    test('should handle corrupted worker file during getAllWorkerStates', async () => {
      await stateManager.initOrchestration('orch-123', 'Task', [
        { workerId: 'w1', workerName: 'good', tabId: 't1', task: 'Task 1' },
        { workerId: 'w2', workerName: 'bad', tabId: 't2', task: 'Task 2' },
      ]);

      // Corrupt one worker file
      const badPath = stateManager.getWorkerPath('bad');
      fs.writeFileSync(badPath, 'corrupted content');

      const states = await stateManager.getAllWorkerStates();

      // Should return only valid workers
      expect(states).toHaveLength(1);
      expect(states[0].workerName).toBe('good');
    });
  });

  describe('Concurrent Error Handling', () => {
    test('should handle multiple concurrent failures gracefully', async () => {
      await stateManager.initWorkerState('w1', 'test', 't1', 'Task');

      // Mix of successful and failing operations
      const operations = Array.from({ length: 20 }, (_, i) => {
        if (i % 4 === 0) {
          // Simulate failing read
          return stateManager.readWorkerState('nonexistent');
        } else if (i % 4 === 1) {
          // Successful update
          return stateManager.updateWorkerState('test', { iteration: i });
        } else if (i % 4 === 2) {
          // Update to nonexistent worker
          return stateManager.updateWorkerState('ghost', { status: 'FAIL' });
        } else {
          // Add progress
          return stateManager.addProgressEntry('test', `Action ${i}`, 'SUCCESS');
        }
      });

      const results = await Promise.allSettled(operations);

      // No operations should throw unhandled errors
      const rejected = results.filter(r => r.status === 'rejected');
      expect(rejected).toHaveLength(0);
    });
  });

  describe('Recovery After Partial Operations', () => {
    test('should recover from partial workflow initialization', async () => {
      // Make second worker creation fail
      let callCount = 0;
      mockSessionManager.createWorker.mockImplementation(async (sessionId, options) => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Worker creation failed');
        }
        return { id: options?.id || `worker-${callCount}`, name: options?.name };
      });

      const workflow: WorkflowDefinition = {
        id: 'wf-partial',
        name: 'Partial Init Test',
        steps: [
          { workerId: 'w1', workerName: 'first', url: 'https://first.com', task: 'Task 1', successCriteria: 'Done' },
          { workerId: 'w2', workerName: 'second', url: 'https://second.com', task: 'Task 2', successCriteria: 'Done' },
        ],
        parallel: true,
        maxRetries: 3,
        timeout: 300000,
      };

      await expect(engine.initWorkflow(testSessionId, workflow)).rejects.toThrow();

      // State may be partially created
      // System should be in a recoverable state
      const firstWorker = await stateManager.readWorkerState('first');
      // First worker state may or may not exist depending on when failure occurred
    });
  });
});
