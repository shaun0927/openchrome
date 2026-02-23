/**
 * Test fixtures and utilities for orchestration tests
 */

import { WorkerState, OrchestrationState, ProgressEntry } from '../../src/orchestration/state-manager';
import { WorkflowDefinition, WorkflowStep, WorkerResult, WorkflowResult } from '../../src/orchestration/workflow-engine';

/**
 * Sample progress entries for testing
 */
export const sampleProgressEntries: ProgressEntry[] = [
  {
    iteration: 1,
    timestamp: '2024-01-15T10:30:15.000Z',
    action: 'Navigate to google.com',
    result: 'SUCCESS',
  },
  {
    iteration: 2,
    timestamp: '2024-01-15T10:31:20.000Z',
    action: 'Search for "test"',
    result: 'SUCCESS',
  },
  {
    iteration: 3,
    timestamp: '2024-01-15T10:33:45.000Z',
    action: 'Extract results',
    result: 'IN_PROGRESS',
  },
];

/**
 * Create a sample worker state
 */
export function createSampleWorkerState(overrides: Partial<WorkerState> = {}): WorkerState {
  return {
    workerId: 'worker-test-123',
    workerName: 'test-worker',
    tabId: 'target-abc-789',
    status: 'INIT',
    iteration: 0,
    maxIterations: 5,
    startedAt: Date.now(),
    lastUpdatedAt: Date.now(),
    task: 'Test task description',
    progressLog: [],
    extractedData: null,
    errors: [],
    ...overrides,
  };
}

/**
 * Create a sample orchestration state
 */
export function createSampleOrchestrationState(
  workerCount: number = 3,
  overrides: Partial<OrchestrationState> = {}
): OrchestrationState {
  const workers = Array.from({ length: workerCount }, (_, i) => ({
    workerId: `worker-${i + 1}`,
    workerName: `worker${i + 1}`,
    status: 'INIT' as const,
  }));

  return {
    orchestrationId: `orch-test-${Date.now()}`,
    status: 'INIT',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    task: 'Test orchestration task',
    workers,
    completedWorkers: 0,
    failedWorkers: 0,
    ...overrides,
  };
}

/**
 * Create a sample workflow step
 */
export function createSampleWorkflowStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    workerId: 'worker-google',
    workerName: 'google',
    url: 'https://google.com',
    task: 'Search for test query',
    successCriteria: 'Search results are displayed',
    ...overrides,
  };
}

/**
 * Create a sample workflow definition
 */
export function createSampleWorkflowDefinition(
  workerCount: number = 3,
  overrides: Partial<WorkflowDefinition> = {}
): WorkflowDefinition {
  const steps: WorkflowStep[] = Array.from({ length: workerCount }, (_, i) => ({
    workerId: `worker-site${i + 1}`,
    workerName: `site${i + 1}`,
    url: `https://site${i + 1}.example.com`,
    task: `Task for site ${i + 1}`,
    successCriteria: `Site ${i + 1} task completed`,
  }));

  return {
    id: `wf-test-${Date.now()}`,
    name: 'Test Workflow',
    steps,
    parallel: true,
    maxRetries: 3,
    timeout: 300000,
    ...overrides,
  };
}

/**
 * Create a sample worker result
 */
export function createSampleWorkerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workerId: 'worker-test-123',
    workerName: 'test-worker',
    tabId: 'target-abc-789',
    status: 'SUCCESS',
    resultSummary: 'Task completed successfully',
    dataExtracted: { items: ['item1', 'item2'] },
    iterations: 3,
    errors: [],
    ...overrides,
  };
}

/**
 * Create a sample workflow result
 */
export function createSampleWorkflowResult(overrides: Partial<WorkflowResult> = {}): WorkflowResult {
  return {
    orchestrationId: `orch-test-${Date.now()}`,
    status: 'COMPLETED',
    workerResults: [
      createSampleWorkerResult({ workerName: 'worker1' }),
      createSampleWorkerResult({ workerName: 'worker2' }),
      createSampleWorkerResult({ workerName: 'worker3' }),
    ],
    completedCount: 3,
    failedCount: 0,
    duration: 15000,
    ...overrides,
  };
}

/**
 * Malicious worker names for security testing (path traversal)
 */
export const maliciousWorkerNames = [
  '../../../etc/passwd',
  '..\\..\\..\\windows\\system32\\config',
  'worker-1/../../../admin',
  'worker\x00.txt',
  'worker-1%2f..%2f..%2fadmin',
  'worker-1\r\nmalicious',
  'worker-1\nmalicious',
  'worker-1|cat /etc/passwd',
  'worker-1; rm -rf /',
  'worker-1 && cat /etc/passwd',
  '....//....//etc/passwd',
];

/**
 * Valid worker names for testing
 */
export const validWorkerNames = [
  'google',
  'coupang',
  '11st',
  'worker-1',
  'worker_underscore',
  'CamelCaseWorker',
  'worker123',
  'site-with-dashes',
];

/**
 * Unicode worker names for testing
 */
export const unicodeWorkerNames = [
  '구글검색',
  '네이버',
  'worker-日本語',
  'работник',
  'العامل',
];

/**
 * Large data samples for stress testing
 */
export const largeDataSamples = {
  /**
   * Generate a large extracted data object
   */
  generateLargeData: (itemCount: number = 10000): Record<string, unknown> => {
    return {
      items: Array.from({ length: itemCount }, (_, i) => ({
        id: i,
        name: `Item ${i}`,
        description: 'x'.repeat(100),
        metadata: {
          created: Date.now(),
          tags: ['tag1', 'tag2', 'tag3'],
        },
      })),
      summary: {
        total: itemCount,
        generated: Date.now(),
      },
    };
  },

  /**
   * Generate a long string
   */
  generateLongString: (length: number = 100000): string => {
    return 'x'.repeat(length);
  },

  /**
   * Generate many progress entries
   */
  generateManyProgressEntries: (count: number = 1000): ProgressEntry[] => {
    return Array.from({ length: count }, (_, i) => ({
      iteration: Math.floor(i / 10) + 1,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      action: `Action ${i}`,
      result: i % 10 === 0 ? 'FAIL' as const : 'SUCCESS' as const,
      error: i % 10 === 0 ? `Error at iteration ${i}` : undefined,
    }));
  },
};

/**
 * Corrupted state content for error handling tests
 */
export const corruptedStateContent = {
  invalidJson: 'this is not valid json {{{',
  emptyMarkdown: '',
  markdownWithoutCodeBlock: '## Worker: test\n### No JSON here',
  markdownWithInvalidCodeBlock: '## Worker: test\n```json\nnot valid json\n```',
  truncatedJson: '```json\n{"workerId": "test", "workerName":',
  nullJson: '```json\nnull\n```',
};

/**
 * Mock session manager for workflow engine tests
 */
export function createMockSessionManager() {
  const workers = new Map<string, { id: string; name?: string }>();
  const targets = new Map<string, string>();
  let workerCounter = 0;
  let targetCounter = 0;

  return {
    createWorker: jest.fn(async (sessionId: string, options?: { id?: string; name?: string }) => {
      workerCounter++;
      const workerId = options?.id || `worker-${workerCounter}`;
      const worker = { id: workerId, name: options?.name };
      workers.set(workerId, worker);
      return worker;
    }),

    createTarget: jest.fn(async (sessionId: string, url: string, workerId?: string) => {
      targetCounter++;
      const targetId = `target-${targetCounter}`;
      targets.set(targetId, url);
      return { targetId };
    }),

    deleteWorker: jest.fn(async (sessionId: string, workerId: string) => {
      workers.delete(workerId);
    }),

    registerExistingTarget: jest.fn(async (sessionId: string, workerId: string, targetId: string) => {
      targets.set(targetId, 'registered');
    }),

    getWorkers: () => workers,
    getTargets: () => targets,
    reset: () => {
      workers.clear();
      targets.clear();
      workerCounter = 0;
      targetCounter = 0;
    },
  };
}

/**
 * Async utilities for tests
 */
export const asyncUtils = {
  /**
   * Wait for a condition to be true
   */
  waitForCondition: async (
    condition: () => boolean | Promise<boolean>,
    timeout: number = 5000,
    interval: number = 100
  ): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await condition()) return;
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error('Condition not met within timeout');
  },

  /**
   * Run a function multiple times concurrently
   */
  runConcurrently: async <T>(
    fn: (index: number) => Promise<T>,
    count: number
  ): Promise<PromiseSettledResult<T>[]> => {
    const promises = Array.from({ length: count }, (_, i) => fn(i));
    return Promise.allSettled(promises);
  },

  /**
   * Measure execution time
   */
  measureTime: async <T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> => {
    const start = Date.now();
    const result = await fn();
    const durationMs = Date.now() - start;
    return { result, durationMs };
  },
};

/**
 * File system utilities for tests
 */
export const fsUtils = {
  /**
   * Read a file with retry
   */
  readWithRetry: async (
    filePath: string,
    fs: typeof import('fs'),
    maxRetries: number = 3
  ): Promise<string> => {
    let lastError: Error | null = null;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return fs.readFileSync(filePath, 'utf-8');
      } catch (error) {
        lastError = error as Error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw lastError;
  },
};

/**
 * Export all fixtures
 */
export const fixtures = {
  sampleProgressEntries,
  createSampleWorkerState,
  createSampleOrchestrationState,
  createSampleWorkflowStep,
  createSampleWorkflowDefinition,
  createSampleWorkerResult,
  createSampleWorkflowResult,
  maliciousWorkerNames,
  validWorkerNames,
  unicodeWorkerNames,
  largeDataSamples,
  corruptedStateContent,
  createMockSessionManager,
  asyncUtils,
  fsUtils,
};
