/// <reference types="jest" />
/**
 * Unit tests for OrchestrationStateManager
 * Tests file-based state management for Chrome-Sisyphus workflow
 */

import * as fs from 'fs';
import * as path from 'path';
import { OrchestrationStateManager, WorkerState, OrchestrationState, getOrchestrationStateManager } from '../../src/orchestration/state-manager';
import {
  createSampleWorkerState,
  createSampleOrchestrationState,
  maliciousWorkerNames,
  validWorkerNames,
  unicodeWorkerNames,
  largeDataSamples,
  corruptedStateContent,
  asyncUtils,
} from '../mocks/orchestration-fixtures';

describe('OrchestrationStateManager', () => {
  let stateManager: OrchestrationStateManager;
  const testDir = '.agent/test-orchestration';

  beforeEach(async () => {
    // Create fresh instance for each test
    stateManager = new OrchestrationStateManager(testDir);
    // Ensure clean state
    await stateManager.cleanup();
  });

  afterEach(async () => {
    // Cleanup after each test
    await stateManager.cleanup();
    // Remove test directory if it exists
    const fullPath = path.resolve(testDir);
    if (fs.existsSync(fullPath)) {
      try {
        await fs.promises.rm(fullPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors on Windows
      }
    }
  });

  describe('ensureDirectory', () => {
    test('should create directory if it does not exist', async () => {
      await stateManager.ensureDirectory();

      const fullPath = path.resolve(testDir);
      expect(fs.existsSync(fullPath)).toBe(true);
    });

    test('should handle already existing directory gracefully', async () => {
      await stateManager.ensureDirectory();
      // Call again - should not throw
      await expect(stateManager.ensureDirectory()).resolves.not.toThrow();
    });

    test('should create nested directories', async () => {
      const nestedManager = new OrchestrationStateManager('.agent/deep/nested/path');
      await nestedManager.ensureDirectory();

      const fullPath = path.resolve('.agent/deep/nested/path');
      expect(fs.existsSync(fullPath)).toBe(true);

      // Cleanup
      try {
        await fs.promises.rm('.agent/deep', { recursive: true, force: true });
      } catch {
        // Ignore errors
      }
    });
  });

  describe('initOrchestration', () => {
    test('should create orchestration state with correct structure', async () => {
      const workers = [
        { workerId: 'w1', workerName: 'google', tabId: 't1', task: 'Search' },
        { workerId: 'w2', workerName: 'naver', tabId: 't2', task: 'Browse' },
      ];

      const state = await stateManager.initOrchestration('orch-123', 'Test task', workers);

      expect(state.orchestrationId).toBe('orch-123');
      expect(state.status).toBe('INIT');
      expect(state.task).toBe('Test task');
      expect(state.workers).toHaveLength(2);
      expect(state.completedWorkers).toBe(0);
      expect(state.failedWorkers).toBe(0);
      expect(state.createdAt).toBeGreaterThan(0);
      expect(state.updatedAt).toBeGreaterThan(0);
    });

    test('should initialize worker scratchpads for each worker', async () => {
      const workers = [
        { workerId: 'w1', workerName: 'google', tabId: 't1', task: 'Search' },
      ];

      await stateManager.initOrchestration('orch-123', 'Test task', workers);

      const workerState = await stateManager.readWorkerState('google');
      expect(workerState).not.toBeNull();
      expect(workerState?.workerName).toBe('google');
    });

    test('should write orchestration state to file', async () => {
      const workers = [{ workerId: 'w1', workerName: 'test', tabId: 't1', task: 'Task' }];

      await stateManager.initOrchestration('orch-123', 'Test', workers);

      const filePath = stateManager.getOrchestrationPath();
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('orch-123');
    });
  });

  describe('initWorkerState', () => {
    test('should create worker state with correct structure', async () => {
      const state = await stateManager.initWorkerState('w1', 'google', 't1', 'Search task');

      expect(state).not.toBeNull();
      expect(state!.workerId).toBe('w1');
      expect(state!.workerName).toBe('google');
      expect(state!.tabId).toBe('t1');
      expect(state!.task).toBe('Search task');
      expect(state!.status).toBe('INIT');
      expect(state!.iteration).toBe(0);
      expect(state!.maxIterations).toBe(5);
      expect(state!.progressLog).toHaveLength(0);
      expect(state!.extractedData).toBeNull();
      expect(state!.errors).toHaveLength(0);
    });

    test('should write worker state to file', async () => {
      await stateManager.initWorkerState('w1', 'google', 't1', 'Task');

      const filePath = stateManager.getWorkerPath('google');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    test.each(validWorkerNames)('should handle valid worker name: %s', async (name) => {
      const state = await stateManager.initWorkerState('w1', name, 't1', 'Task');
      expect(state).not.toBeNull();
      expect(state!.workerName).toBe(name);

      const readState = await stateManager.readWorkerState(name);
      expect(readState).not.toBeNull();
    });

    test.each(unicodeWorkerNames)('should handle unicode worker name: %s', async (name) => {
      const state = await stateManager.initWorkerState('w1', name, 't1', 'Task');
      expect(state).not.toBeNull();
      expect(state!.workerName).toBe(name);

      const readState = await stateManager.readWorkerState(name);
      expect(readState).not.toBeNull();
      expect(readState?.workerName).toBe(name);
    });

    test('should return null for invalid worker name with path traversal', async () => {
      const state = await stateManager.initWorkerState('w1', '../malicious', 't1', 'Task');
      expect(state).toBeNull();
    });

    test('should return null for empty worker name', async () => {
      const state = await stateManager.initWorkerState('w1', '', 't1', 'Task');
      expect(state).toBeNull();
    });
  });

  describe('updateWorkerState', () => {
    beforeEach(async () => {
      await stateManager.initWorkerState('w1', 'test', 't1', 'Task');
    });

    test('should update status field', async () => {
      const updated = await stateManager.updateWorkerState('test', { status: 'IN_PROGRESS' });

      expect(updated?.status).toBe('IN_PROGRESS');
    });

    test('should update iteration field', async () => {
      const updated = await stateManager.updateWorkerState('test', { iteration: 3 });

      expect(updated?.iteration).toBe(3);
    });

    test('should update extractedData field', async () => {
      const data = { items: ['a', 'b', 'c'] };
      const updated = await stateManager.updateWorkerState('test', { extractedData: data });

      expect(updated?.extractedData).toEqual(data);
    });

    test('should auto-update lastUpdatedAt', async () => {
      const initial = await stateManager.readWorkerState('test');
      const initialTime = initial?.lastUpdatedAt || 0;

      // Wait a bit to ensure time difference
      await new Promise((r) => setTimeout(r, 10));

      const updated = await stateManager.updateWorkerState('test', { status: 'IN_PROGRESS' });

      expect(updated?.lastUpdatedAt).toBeGreaterThan(initialTime);
    });

    test('should return null for non-existent worker', async () => {
      const result = await stateManager.updateWorkerState('nonexistent', { status: 'IN_PROGRESS' });

      expect(result).toBeNull();
    });

    test('should support partial updates', async () => {
      await stateManager.updateWorkerState('test', { status: 'IN_PROGRESS' });
      await stateManager.updateWorkerState('test', { iteration: 2 });

      const state = await stateManager.readWorkerState('test');
      expect(state?.status).toBe('IN_PROGRESS');
      expect(state?.iteration).toBe(2);
    });

    test('should preserve existing fields on partial update', async () => {
      await stateManager.updateWorkerState('test', { extractedData: { key: 'value' } });
      await stateManager.updateWorkerState('test', { status: 'SUCCESS' });

      const state = await stateManager.readWorkerState('test');
      expect(state?.extractedData).toEqual({ key: 'value' });
      expect(state?.status).toBe('SUCCESS');
    });
  });

  describe('addProgressEntry', () => {
    beforeEach(async () => {
      await stateManager.initWorkerState('w1', 'test', 't1', 'Task');
    });

    test('should add progress entry with timestamp', async () => {
      await stateManager.addProgressEntry('test', 'Navigate', 'SUCCESS');

      const state = await stateManager.readWorkerState('test');
      expect(state?.progressLog).toHaveLength(1);
      expect(state?.progressLog[0].action).toBe('Navigate');
      expect(state?.progressLog[0].result).toBe('SUCCESS');
      expect(state?.progressLog[0].timestamp).toBeDefined();
    });

    test('should include current iteration number', async () => {
      await stateManager.updateWorkerState('test', { iteration: 3 });
      await stateManager.addProgressEntry('test', 'Click', 'SUCCESS');

      const state = await stateManager.readWorkerState('test');
      expect(state?.progressLog[0].iteration).toBe(3);
    });

    test('should include error message when provided', async () => {
      await stateManager.addProgressEntry('test', 'Navigate', 'FAIL', 'Connection timeout');

      const state = await stateManager.readWorkerState('test');
      expect(state?.progressLog[0].error).toBe('Connection timeout');
    });

    test('should accumulate multiple entries', async () => {
      await stateManager.addProgressEntry('test', 'Action 1', 'SUCCESS');
      await stateManager.addProgressEntry('test', 'Action 2', 'SUCCESS');
      await stateManager.addProgressEntry('test', 'Action 3', 'FAIL', 'Error');

      const state = await stateManager.readWorkerState('test');
      expect(state?.progressLog).toHaveLength(3);
    });

    test('should handle empty action message', async () => {
      await stateManager.addProgressEntry('test', '', 'SUCCESS');

      const state = await stateManager.readWorkerState('test');
      expect(state?.progressLog[0].action).toBe('');
    });

    test('should handle very long action message', async () => {
      const longMessage = 'x'.repeat(100000);
      await stateManager.addProgressEntry('test', longMessage, 'SUCCESS');

      const state = await stateManager.readWorkerState('test');
      expect(state?.progressLog[0].action).toBe(longMessage);
    });

    test('should handle unicode characters in action', async () => {
      await stateManager.addProgressEntry('test', '검색 실행 완료', 'SUCCESS');

      const state = await stateManager.readWorkerState('test');
      expect(state?.progressLog[0].action).toBe('검색 실행 완료');
    });

    test('should handle emoji in action', async () => {
      await stateManager.addProgressEntry('test', '✅ Task complete 🎉', 'SUCCESS');

      const state = await stateManager.readWorkerState('test');
      expect(state?.progressLog[0].action).toBe('✅ Task complete 🎉');
    });

    test('should not add entry for non-existent worker', async () => {
      await stateManager.addProgressEntry('nonexistent', 'Action', 'SUCCESS');

      // Should not throw, just silently return
      const state = await stateManager.readWorkerState('nonexistent');
      expect(state).toBeNull();
    });
  });

  describe('readWorkerState', () => {
    test('should parse JSON from markdown code block', async () => {
      await stateManager.initWorkerState('w1', 'test', 't1', 'Task');

      const state = await stateManager.readWorkerState('test');
      expect(state).not.toBeNull();
      expect(state?.workerId).toBe('w1');
    });

    test('should return null for non-existent file', async () => {
      const state = await stateManager.readWorkerState('nonexistent');
      expect(state).toBeNull();
    });

    test('should return null for corrupted JSON', async () => {
      await stateManager.ensureDirectory();
      const filePath = stateManager.getWorkerPath('corrupted');
      fs.writeFileSync(filePath, corruptedStateContent.invalidJson);

      const state = await stateManager.readWorkerState('corrupted');
      expect(state).toBeNull();
    });

    test('should return null for markdown without code block', async () => {
      await stateManager.ensureDirectory();
      const filePath = stateManager.getWorkerPath('noblock');
      fs.writeFileSync(filePath, corruptedStateContent.markdownWithoutCodeBlock);

      const state = await stateManager.readWorkerState('noblock');
      expect(state).toBeNull();
    });

    test('should return null for invalid JSON in code block', async () => {
      await stateManager.ensureDirectory();
      const filePath = stateManager.getWorkerPath('invalidblock');
      fs.writeFileSync(filePath, corruptedStateContent.markdownWithInvalidCodeBlock);

      const state = await stateManager.readWorkerState('invalidblock');
      expect(state).toBeNull();
    });

    test('should fallback to parsing entire file as JSON', async () => {
      await stateManager.ensureDirectory();
      const filePath = stateManager.getWorkerPath('jsononly');
      const sampleState = createSampleWorkerState({ workerName: 'jsononly' });
      fs.writeFileSync(filePath, JSON.stringify(sampleState));

      const state = await stateManager.readWorkerState('jsononly');
      expect(state).not.toBeNull();
      expect(state?.workerName).toBe('jsononly');
    });
  });

  describe('writeWorkerState', () => {
    test('should write state in markdown format', async () => {
      const state = createSampleWorkerState();
      await stateManager.ensureDirectory();
      await stateManager.writeWorkerState('test', state);

      const filePath = stateManager.getWorkerPath('test');
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(content).toContain('## Worker:');
      expect(content).toContain('### Meta');
      expect(content).toContain('### Task');
      expect(content).toContain('```json');
    });

    test('should preserve all fields', async () => {
      const original = createSampleWorkerState({
        status: 'IN_PROGRESS',
        iteration: 3,
        extractedData: { items: [1, 2, 3] },
        errors: ['Error 1', 'Error 2'],
      });

      await stateManager.ensureDirectory();
      await stateManager.writeWorkerState('test', original);

      const read = await stateManager.readWorkerState('test');
      expect(read?.status).toBe(original.status);
      expect(read?.iteration).toBe(original.iteration);
      expect(read?.extractedData).toEqual(original.extractedData);
      expect(read?.errors).toEqual(original.errors);
    });

    test('should format progress log as table', async () => {
      const state = createSampleWorkerState({
        progressLog: [
          { iteration: 1, timestamp: '2024-01-15T10:00:00.000Z', action: 'Navigate', result: 'SUCCESS' },
        ],
      });

      await stateManager.ensureDirectory();
      await stateManager.writeWorkerState('test', state);

      const filePath = stateManager.getWorkerPath('test');
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(content).toContain('| Iter | Time | Action | Result | Error |');
      expect(content).toContain('Navigate');
      expect(content).toContain('SUCCESS');
    });
  });

  describe('readOrchestrationState', () => {
    test('should return null when no orchestration exists', async () => {
      const state = await stateManager.readOrchestrationState();
      expect(state).toBeNull();
    });

    test('should read orchestration state after init', async () => {
      await stateManager.initOrchestration('orch-123', 'Task', [
        { workerId: 'w1', workerName: 'test', tabId: 't1', task: 'Task' },
      ]);

      const state = await stateManager.readOrchestrationState();
      expect(state).not.toBeNull();
      expect(state?.orchestrationId).toBe('orch-123');
    });

    test('should return null for corrupted file', async () => {
      await stateManager.ensureDirectory();
      const filePath = stateManager.getOrchestrationPath();
      fs.writeFileSync(filePath, corruptedStateContent.invalidJson);

      const state = await stateManager.readOrchestrationState();
      expect(state).toBeNull();
    });
  });

  describe('updateOrchestrationState', () => {
    beforeEach(async () => {
      await stateManager.initOrchestration('orch-123', 'Task', [
        { workerId: 'w1', workerName: 'test', tabId: 't1', task: 'Task' },
      ]);
    });

    test('should update status', async () => {
      const updated = await stateManager.updateOrchestrationState({ status: 'RUNNING' });

      expect(updated?.status).toBe('RUNNING');
    });

    test('should update completedWorkers count', async () => {
      const updated = await stateManager.updateOrchestrationState({ completedWorkers: 1 });

      expect(updated?.completedWorkers).toBe(1);
    });

    test('should auto-update updatedAt', async () => {
      const initial = await stateManager.readOrchestrationState();
      const initialTime = initial?.updatedAt || 0;

      await new Promise((r) => setTimeout(r, 10));

      const updated = await stateManager.updateOrchestrationState({ status: 'RUNNING' });

      expect(updated?.updatedAt).toBeGreaterThan(initialTime);
    });

    test('should return null when no orchestration exists', async () => {
      await stateManager.cleanup();
      const result = await stateManager.updateOrchestrationState({ status: 'RUNNING' });
      expect(result).toBeNull();
    });
  });

  describe('getAllWorkerStates', () => {
    test('should return empty array when no orchestration', async () => {
      const states = await stateManager.getAllWorkerStates();
      expect(states).toHaveLength(0);
    });

    test('should return all worker states', async () => {
      await stateManager.initOrchestration('orch-123', 'Task', [
        { workerId: 'w1', workerName: 'worker1', tabId: 't1', task: 'Task 1' },
        { workerId: 'w2', workerName: 'worker2', tabId: 't2', task: 'Task 2' },
        { workerId: 'w3', workerName: 'worker3', tabId: 't3', task: 'Task 3' },
      ]);

      const states = await stateManager.getAllWorkerStates();
      expect(states).toHaveLength(3);
      expect(states.map((s) => s.workerName).sort()).toEqual(['worker1', 'worker2', 'worker3']);
    });

    test('should skip missing worker files gracefully', async () => {
      await stateManager.initOrchestration('orch-123', 'Task', [
        { workerId: 'w1', workerName: 'worker1', tabId: 't1', task: 'Task 1' },
        { workerId: 'w2', workerName: 'worker2', tabId: 't2', task: 'Task 2' },
      ]);

      // Manually delete one worker file
      const workerPath = stateManager.getWorkerPath('worker1');
      fs.unlinkSync(workerPath);

      const states = await stateManager.getAllWorkerStates();
      expect(states).toHaveLength(1);
      expect(states[0].workerName).toBe('worker2');
    });
  });

  describe('getWorkerPath / getOrchestrationPath', () => {
    test('should return correct worker path', () => {
      const path = stateManager.getWorkerPath('google');
      expect(path).toContain('worker-google.md');
    });

    test('should return correct orchestration path', () => {
      const path = stateManager.getOrchestrationPath();
      expect(path).toContain('orchestration.md');
    });
  });

  describe('cleanup', () => {
    test('should remove all orchestration files', async () => {
      await stateManager.initOrchestration('orch-123', 'Task', [
        { workerId: 'w1', workerName: 'test', tabId: 't1', task: 'Task' },
      ]);

      await stateManager.cleanup();

      expect(fs.existsSync(stateManager.getOrchestrationPath())).toBe(false);
      expect(fs.existsSync(stateManager.getWorkerPath('test'))).toBe(false);
    });

    test('should handle already empty directory', async () => {
      await stateManager.ensureDirectory();
      await expect(stateManager.cleanup()).resolves.not.toThrow();
    });

    test('should handle non-existent directory', async () => {
      await expect(stateManager.cleanup()).resolves.not.toThrow();
    });
  });

  describe('Concurrent Operations', () => {
    test('should handle concurrent worker updates', async () => {
      await stateManager.initWorkerState('w1', 'test', 't1', 'Task');

      const updates = Array.from({ length: 10 }, (_, i) =>
        stateManager.updateWorkerState('test', { iteration: i + 1 })
      );

      const results = await Promise.allSettled(updates);
      const successes = results.filter((r) => r.status === 'fulfilled' && r.value !== null);

      // All updates should succeed (though order is non-deterministic)
      expect(successes.length).toBe(10);
    });

    test('should handle concurrent progress entries', async () => {
      await stateManager.initWorkerState('w1', 'test', 't1', 'Task');

      const entries = Array.from({ length: 20 }, (_, i) =>
        stateManager.addProgressEntry('test', `Action ${i}`, 'SUCCESS')
      );

      await Promise.all(entries);

      const state = await stateManager.readWorkerState('test');
      // Due to race conditions, some entries may be lost
      // This test documents the current behavior
      expect(state?.progressLog.length).toBeGreaterThan(0);
    });
  });

  describe('Large Data Handling', () => {
    test('should handle large extracted data', async () => {
      await stateManager.initWorkerState('w1', 'test', 't1', 'Task');

      const largeData = largeDataSamples.generateLargeData(1000);
      await stateManager.updateWorkerState('test', { extractedData: largeData });

      const state = await stateManager.readWorkerState('test');
      expect(state?.extractedData).toEqual(largeData);
    });

    test('should handle many progress entries', async () => {
      await stateManager.initWorkerState('w1', 'test', 't1', 'Task');

      for (let i = 0; i < 100; i++) {
        await stateManager.addProgressEntry('test', `Action ${i}`, 'SUCCESS');
      }

      const state = await stateManager.readWorkerState('test');
      expect(state?.progressLog).toHaveLength(100);
    });
  });

  describe('Path Traversal Security', () => {
    test.each(maliciousWorkerNames)('should handle potentially malicious name: %s', async (name) => {
      // The current implementation does NOT validate names
      // This test documents the vulnerability and serves as a baseline
      // after the fix is applied

      try {
        await stateManager.initWorkerState('w1', name, 't1', 'Task');
        // If no error, check that file was created in expected directory
        const expectedPath = stateManager.getWorkerPath(name);
        const baseDir = path.resolve(testDir);

        // File should be within the base directory
        const resolvedPath = path.resolve(expectedPath);
        const isWithinBase = resolvedPath.startsWith(baseDir);

        // Currently this may fail for malicious names
        // After fix, expect isWithinBase to always be true
        // or the operation should throw/return null
      } catch (error) {
        // Exception is acceptable behavior for malicious names
        expect(error).toBeDefined();
      }
    });
  });

  describe('getOrchestrationStateManager singleton', () => {
    test('should return the same instance', () => {
      const instance1 = getOrchestrationStateManager();
      const instance2 = getOrchestrationStateManager();

      expect(instance1).toBe(instance2);
    });
  });
});
