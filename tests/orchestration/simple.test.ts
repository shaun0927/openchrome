/// <reference types="jest" />
/**
 * Simple test to verify Jest is working
 */

import * as fs from 'fs';
import * as path from 'path';
import { OrchestrationStateManager } from '../../src/orchestration/state-manager';

describe('Simple OrchestrationStateManager Tests', () => {
  let stateManager: OrchestrationStateManager;
  const testDir = '.agent/test-simple';

  beforeEach(async () => {
    stateManager = new OrchestrationStateManager(testDir);
    await stateManager.cleanup();
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
  });

  test('should create directory', async () => {
    await stateManager.ensureDirectory();
    const fullPath = path.resolve(testDir);
    expect(fs.existsSync(fullPath)).toBe(true);
  });

  test('should init worker state', async () => {
    const state = await stateManager.initWorkerState('w1', 'google', 't1', 'Search task');
    expect(state).not.toBeNull();
    expect(state?.workerName).toBe('google');
  });

  test('should reject invalid worker name', async () => {
    const state = await stateManager.initWorkerState('w1', '../bad', 't1', 'Task');
    expect(state).toBeNull();
  });

  test('should read and write worker state', async () => {
    await stateManager.initWorkerState('w1', 'test', 't1', 'Task');
    const state = await stateManager.readWorkerState('test');
    expect(state).not.toBeNull();
    expect(state?.status).toBe('INIT');
  });
});
