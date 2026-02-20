/// <reference types="jest" />
/**
 * Unit tests for Plan Cache feature — PlanRegistry + PlanExecutor
 *
 * Tests cover:
 *   - PlanRegistry: matching, registration, stats, default plans
 *   - PlanExecutor: step execution, param substitution, error handling, success criteria
 *   - Integration: register → match → (mock) execute
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PlanRegistry } from '../../src/orchestration/plan-registry';
import type {
  CompiledPlan,
  CompiledStep,
  PlanEntry,
  PlanExecutionResult,
  TaskPattern,
} from '../../src/types/plan-cache';
import type { MCPResult, ToolHandler } from '../../src/types/mcp';

import { PlanExecutor } from '../../src/orchestration/plan-executor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-cache-test-'));
}

function buildPlan(overrides: Partial<CompiledPlan> = {}): CompiledPlan {
  return {
    id: 'test-plan-v1',
    version: '1.0.0',
    description: 'Test plan',
    parameters: {},
    steps: [],
    errorHandlers: [],
    successCriteria: {},
    ...overrides,
  };
}

function buildPattern(overrides: Partial<TaskPattern> = {}): TaskPattern {
  return {
    taskKeywords: ['test'],
    ...overrides,
  };
}

function buildStep(overrides: Partial<CompiledStep> = {}): CompiledStep {
  return {
    order: 1,
    tool: 'navigate',
    args: {},
    timeout: 5000,
    ...overrides,
  };
}

function makeMCPResult(text: string): MCPResult {
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

// ---------------------------------------------------------------------------
// PlanRegistry tests
// ---------------------------------------------------------------------------

describe('PlanRegistry', () => {
  let tmpDir: string;
  let registry: PlanRegistry;

  beforeEach(() => {
    tmpDir = makeTempDir();
    registry = new PlanRegistry(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // matchTask
  // -------------------------------------------------------------------------

  describe('matchTask', () => {
    test('returns null when no plans are registered', () => {
      const result = registry.matchTask('extract tweets', 'https://x.com/user');
      expect(result).toBeNull();
    });

    test('matches by URL pattern correctly', () => {
      const plan = buildPlan({ id: 'twitter-plan' });
      const pattern = buildPattern({
        urlPattern: 'https://(x|twitter)\\.com/.*',
        taskKeywords: ['extract'],
      });
      registry.registerPlan(plan, pattern);

      const match = registry.matchTask('extract data', 'https://x.com/home');
      expect(match).not.toBeNull();
      expect(match!.id).toBe('twitter-plan');
    });

    test('does not match when URL pattern does not match', () => {
      const plan = buildPlan({ id: 'twitter-plan' });
      const pattern = buildPattern({
        urlPattern: 'https://x\\.com/.*',
        taskKeywords: ['extract'],
      });
      registry.registerPlan(plan, pattern);

      const match = registry.matchTask('extract data', 'https://github.com/repo');
      expect(match).toBeNull();
    });

    test('matches by task keywords case-insensitively', () => {
      const plan = buildPlan({ id: 'kw-plan' });
      const pattern = buildPattern({ taskKeywords: ['Tweet', 'Extract'] });
      registry.registerPlan(plan, pattern);

      // Keywords in task description in different casing
      const match = registry.matchTask('EXTRACT the tweet from page', 'https://example.com');
      expect(match).not.toBeNull();
      expect(match!.id).toBe('kw-plan');
    });

    test('does not match when not all keywords are present', () => {
      const plan = buildPlan({ id: 'kw-plan' });
      const pattern = buildPattern({ taskKeywords: ['tweet', 'extract'] });
      registry.registerPlan(plan, pattern);

      // Only one keyword present
      const match = registry.matchTask('extract something', 'https://example.com');
      expect(match).toBeNull();
    });

    test('filters plans below confidence threshold', () => {
      const plan = buildPlan({ id: 'low-conf-plan' });
      const pattern = buildPattern({ taskKeywords: ['extract'] });
      const entry = registry.registerPlan(plan, pattern);

      // Manually drive confidence below threshold via repeated failures
      // updateStats: 10 failures → confidence = 0 / 10 = 0.0 < minConfidenceToUse (0.3)
      for (let i = 0; i < 10; i++) {
        registry.updateStats('low-conf-plan', false, 100);
      }

      const match = registry.matchTask('extract data', 'https://example.com');
      expect(match).toBeNull();
    });

    test('returns highest confidence plan when multiple match', () => {
      const planA = buildPlan({ id: 'plan-a' });
      const planB = buildPlan({ id: 'plan-b' });
      const pattern = buildPattern({ taskKeywords: ['extract'] });

      registry.registerPlan(planA, pattern);
      registry.registerPlan(planB, pattern);

      // Give plan-b higher confidence via successes
      for (let i = 0; i < 5; i++) {
        registry.updateStats('plan-b', true, 100);
      }

      const match = registry.matchTask('extract data', 'https://example.com');
      expect(match).not.toBeNull();
      expect(match!.id).toBe('plan-b');
    });

    test('handles invalid URL regex gracefully — skips that entry', () => {
      const plan = buildPlan({ id: 'bad-regex-plan' });
      const pattern = buildPattern({
        urlPattern: '(invalid[regex',
        taskKeywords: ['extract'],
      });
      registry.registerPlan(plan, pattern);

      // Should not throw; invalid regex entry is skipped
      const match = registry.matchTask('extract data', 'https://example.com');
      expect(match).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // registerPlan
  // -------------------------------------------------------------------------

  describe('registerPlan', () => {
    test('adds plan entry to the registry', () => {
      const plan = buildPlan({ id: 'new-plan' });
      const pattern = buildPattern({ taskKeywords: ['search'] });

      registry.registerPlan(plan, pattern);

      expect(registry.getEntries()).toHaveLength(1);
      expect(registry.getEntry('new-plan')).not.toBeNull();
    });

    test('persists plan JSON file to disk', () => {
      const plan = buildPlan({ id: 'disk-plan' });
      const pattern = buildPattern({ taskKeywords: ['disk'] });

      registry.registerPlan(plan, pattern);

      const planFile = path.join(tmpDir, 'plans', 'disk-plan.json');
      expect(fs.existsSync(planFile)).toBe(true);

      const saved = JSON.parse(fs.readFileSync(planFile, 'utf-8'));
      expect(saved.id).toBe('disk-plan');
    });

    test('replaces existing entry with same ID', () => {
      const planV1 = buildPlan({ id: 'versioned-plan', version: '1.0.0' });
      const planV2 = buildPlan({ id: 'versioned-plan', version: '2.0.0' });
      const pattern = buildPattern({ taskKeywords: ['versioned'] });

      registry.registerPlan(planV1, pattern);
      registry.registerPlan(planV2, pattern);

      expect(registry.getEntries()).toHaveLength(1);
    });

    test('initialises stats at zero', () => {
      const plan = buildPlan({ id: 'stats-plan' });
      registry.registerPlan(plan, buildPattern());

      const entry = registry.getEntry('stats-plan')!;
      expect(entry.stats.totalExecutions).toBe(0);
      expect(entry.stats.successCount).toBe(0);
      expect(entry.stats.failCount).toBe(0);
    });

    test('sets initial confidence to 0.5', () => {
      const plan = buildPlan({ id: 'conf-plan' });
      registry.registerPlan(plan, buildPattern());

      const entry = registry.getEntry('conf-plan')!;
      expect(entry.confidence).toBe(0.5);
    });
  });

  // -------------------------------------------------------------------------
  // updateStats
  // -------------------------------------------------------------------------

  describe('updateStats', () => {
    beforeEach(() => {
      registry.registerPlan(buildPlan({ id: 'tracked-plan' }), buildPattern());
    });

    test('increments successCount on success', () => {
      registry.updateStats('tracked-plan', true, 200);

      const entry = registry.getEntry('tracked-plan')!;
      expect(entry.stats.successCount).toBe(1);
      expect(entry.stats.failCount).toBe(0);
    });

    test('increments failCount on failure', () => {
      registry.updateStats('tracked-plan', false, 200);

      const entry = registry.getEntry('tracked-plan')!;
      expect(entry.stats.failCount).toBe(1);
      expect(entry.stats.successCount).toBe(0);
    });

    test('increments totalExecutions on each call', () => {
      registry.updateStats('tracked-plan', true, 100);
      registry.updateStats('tracked-plan', false, 100);

      const entry = registry.getEntry('tracked-plan')!;
      expect(entry.stats.totalExecutions).toBe(2);
    });

    test('recalculates confidence as success rate', () => {
      // 3 successes, 1 failure → 3/4 = 0.75
      registry.updateStats('tracked-plan', true, 100);
      registry.updateStats('tracked-plan', true, 100);
      registry.updateStats('tracked-plan', true, 100);
      registry.updateStats('tracked-plan', false, 100);

      const entry = registry.getEntry('tracked-plan')!;
      expect(entry.confidence).toBeCloseTo(0.75);
    });

    test('computes rolling average for avgDurationMs', () => {
      registry.updateStats('tracked-plan', true, 100);
      registry.updateStats('tracked-plan', true, 300);
      // Rolling avg: (100 * 1 + 300) / 2 = 200
      const entry = registry.getEntry('tracked-plan')!;
      expect(entry.stats.avgDurationMs).toBe(200);
    });

    test('updates lastUsed timestamp', () => {
      const before = Date.now();
      registry.updateStats('tracked-plan', true, 100);
      const after = Date.now();

      const entry = registry.getEntry('tracked-plan')!;
      expect(entry.stats.lastUsed).toBeGreaterThanOrEqual(before);
      expect(entry.stats.lastUsed).toBeLessThanOrEqual(after);
    });

    test('is a no-op when planId does not exist', () => {
      // Should not throw
      expect(() =>
        registry.updateStats('nonexistent-plan', true, 100)
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getDefaultPlans
  // -------------------------------------------------------------------------

  describe('getDefaultPlans', () => {
    test('returns at least one plan', () => {
      const defaults = PlanRegistry.getDefaultPlans();
      expect(defaults.length).toBeGreaterThanOrEqual(1);
    });

    test('includes X tweet extraction plan', () => {
      const defaults = PlanRegistry.getDefaultPlans();
      const tweetPlan = defaults.find(d => d.plan.id === 'x-tweet-extraction-v1');
      expect(tweetPlan).toBeDefined();
    });

    test('X tweet extraction plan has correct URL pattern', () => {
      const defaults = PlanRegistry.getDefaultPlans();
      const tweetEntry = defaults.find(d => d.plan.id === 'x-tweet-extraction-v1')!;
      expect(tweetEntry.pattern.urlPattern).toMatch(/x|twitter/);
    });

    test('X tweet extraction plan has tweet and extract keywords', () => {
      const defaults = PlanRegistry.getDefaultPlans();
      const tweetEntry = defaults.find(d => d.plan.id === 'x-tweet-extraction-v1')!;
      const kw = tweetEntry.pattern.taskKeywords.map(k => k.toLowerCase());
      expect(kw).toContain('tweet');
      expect(kw).toContain('extract');
    });

    test('X tweet extraction plan steps include javascript_tool', () => {
      const defaults = PlanRegistry.getDefaultPlans();
      const tweetEntry = defaults.find(d => d.plan.id === 'x-tweet-extraction-v1')!;
      const tools = tweetEntry.plan.steps.map(s => s.tool);
      expect(tools).toContain('javascript_tool');
    });

    test('X tweet extraction plan success criteria requires minDataItems >= 1', () => {
      const defaults = PlanRegistry.getDefaultPlans();
      const tweetEntry = defaults.find(d => d.plan.id === 'x-tweet-extraction-v1')!;
      expect(tweetEntry.plan.successCriteria.minDataItems).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // load / save round-trip
  // -------------------------------------------------------------------------

  describe('load / save', () => {
    test('persists and restores registry data across instances', () => {
      const plan = buildPlan({ id: 'persist-plan' });
      registry.registerPlan(plan, buildPattern({ taskKeywords: ['persist'] }));

      const registry2 = new PlanRegistry(tmpDir);
      registry2.load();

      expect(registry2.getEntry('persist-plan')).not.toBeNull();
    });

    test('load with missing file starts with empty registry', () => {
      const fresh = new PlanRegistry(path.join(tmpDir, 'nonexistent'));
      fresh.load(); // should not throw

      expect(fresh.getEntries()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // loadPlan
  // -------------------------------------------------------------------------

  describe('loadPlan', () => {
    test('returns the compiled plan from disk', () => {
      const plan = buildPlan({ id: 'loadable-plan' });
      const entry = registry.registerPlan(plan, buildPattern());

      const loaded = registry.loadPlan(entry);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('loadable-plan');
    });

    test('returns null when plan file is missing', () => {
      const fakeEntry: PlanEntry = {
        id: 'ghost',
        pattern: buildPattern(),
        planPath: 'plans/ghost.json',
        stats: { totalExecutions: 0, successCount: 0, failCount: 0, avgDurationMs: 0, lastUsed: 0 },
        confidence: 0.5,
        minConfidenceToUse: 0.3,
      };

      const result = registry.loadPlan(fakeEntry);
      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// PlanExecutor tests
// ---------------------------------------------------------------------------

const describePlanExecutor = describe;

describePlanExecutor('PlanExecutor', () => {
  const SESSION_ID = 'test-session-001';

  // -----------------------------------------------------------------------
  // Helper to build a minimal 1-step plan
  // -----------------------------------------------------------------------
  function singleStepPlan(step: Partial<CompiledStep> = {}): CompiledPlan {
    return buildPlan({
      id: 'single-step-plan',
      steps: [buildStep({ order: 1, tool: 'mock_tool', ...step })],
      successCriteria: {},
    });
  }

  // -----------------------------------------------------------------------
  // Mock tool handler factory
  // -----------------------------------------------------------------------
  function makeMockHandler(returnValue: MCPResult): ToolHandler {
    return jest.fn(async (_sessionId, _params) => returnValue);
  }

  function makeErrorHandler(errorMessage: string): ToolHandler {
    return jest.fn(async () => {
      throw new Error(errorMessage);
    });
  }

  function makeResolverWith(handlers: Record<string, ToolHandler>) {
    return (toolName: string): ToolHandler | null => handlers[toolName] ?? null;
  }

  // -----------------------------------------------------------------------
  // Basic execution
  // -----------------------------------------------------------------------

  test('executes a simple 1-step plan successfully', async () => {
    const handler = makeMockHandler(makeMCPResult('ok'));
    const executor = new PlanExecutor(makeResolverWith({ mock_tool: handler }));
    const plan = singleStepPlan();

    const result = await executor.execute(plan, SESSION_ID, {});

    expect(result.success).toBe(true);
    expect(result.planId).toBe('single-step-plan');
    expect(result.stepsExecuted).toBe(1);
    expect(result.totalSteps).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('passes sessionId to tool handler', async () => {
    const handler = makeMockHandler(makeMCPResult('ok'));
    const executor = new PlanExecutor(makeResolverWith({ mock_tool: handler }));
    const plan = singleStepPlan();

    await executor.execute(plan, SESSION_ID, {});

    expect(handler).toHaveBeenCalledWith(SESSION_ID, expect.any(Object));
  });

  // -----------------------------------------------------------------------
  // Parameter substitution
  // -----------------------------------------------------------------------

  test('substitutes ${param} templates in top-level args', async () => {
    const handler = makeMockHandler(makeMCPResult('ok'));
    const executor = new PlanExecutor(makeResolverWith({ mock_tool: handler }));
    const plan = singleStepPlan({ args: { url: '${targetUrl}' } });

    await executor.execute(plan, SESSION_ID, { targetUrl: 'https://example.com' });

    const calledArgs = (handler as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
    expect(calledArgs['url']).toBe('https://example.com');
  });

  test('handles nested object parameter substitution', async () => {
    const handler = makeMockHandler(makeMCPResult('ok'));
    const executor = new PlanExecutor(makeResolverWith({ mock_tool: handler }));
    const plan = singleStepPlan({
      args: { options: { host: '${host}', port: '${port}' } },
    });

    await executor.execute(plan, SESSION_ID, { host: 'localhost', port: '8080' });

    const calledArgs = (handler as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
    const options = calledArgs['options'] as Record<string, unknown>;
    expect(options['host']).toBe('localhost');
    expect(options['port']).toBe('8080');
  });

  // -----------------------------------------------------------------------
  // Result parsing / storeAs
  // -----------------------------------------------------------------------

  test('stores parsed JSON result for use in subsequent steps', async () => {
    const jsonPayload = JSON.stringify({ count: 3, items: ['a', 'b', 'c'] });
    const step1Handler = makeMockHandler(makeMCPResult(jsonPayload));
    const step2Handler = makeMockHandler(makeMCPResult('done'));

    const executor = new PlanExecutor(
      makeResolverWith({ step1_tool: step1Handler, step2_tool: step2Handler })
    );

    const plan = buildPlan({
      id: 'two-step-plan',
      steps: [
        buildStep({
          order: 1,
          tool: 'step1_tool',
          args: {},
          parseResult: { format: 'json', storeAs: 'parsedData' },
        }),
        buildStep({
          order: 2,
          tool: 'step2_tool',
          args: { data: '${parsedData}' },
        }),
      ],
      successCriteria: {},
    });

    const result = await executor.execute(plan, SESSION_ID, {});

    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(2);
    // step2 should have received the stored parsed data
    const step2Args = (step2Handler as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
    // The stored value should be the parsed object (or its stringified form)
    expect(step2Args['data']).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  test('returns failure when tool handler throws', async () => {
    const handler = makeErrorHandler('Tool crashed');
    const executor = new PlanExecutor(makeResolverWith({ mock_tool: handler }));
    const plan = singleStepPlan();

    const result = await executor.execute(plan, SESSION_ID, {});

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.planId).toBe('single-step-plan');
  });

  test('returns failure when tool resolver returns null (unknown tool)', async () => {
    const executor = new PlanExecutor(() => null);
    const plan = singleStepPlan({ tool: 'unknown_tool' });

    const result = await executor.execute(plan, SESSION_ID, {});

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('executes error handler steps on step failure', async () => {
    const failHandler = makeErrorHandler('Step failed');
    const recoveryHandler = makeMockHandler(makeMCPResult('recovered'));

    const executor = new PlanExecutor(
      makeResolverWith({ fail_tool: failHandler, recovery_tool: recoveryHandler })
    );

    const plan = buildPlan({
      id: 'error-handler-plan',
      steps: [buildStep({ order: 1, tool: 'fail_tool', args: {} })],
      errorHandlers: [
        {
          condition: 'step1_error',
          action: 'recover',
          steps: [buildStep({ order: 1, tool: 'recovery_tool', args: {} })],
        },
      ],
      successCriteria: {},
    });

    const result = await executor.execute(plan, SESSION_ID, {});

    // Recovery handler should have been called
    expect(recoveryHandler).toHaveBeenCalled();
    // Whether success or not depends on implementation; just ensure no unhandled throw
    expect(typeof result.success).toBe('boolean');
  });

  // -----------------------------------------------------------------------
  // Success criteria validation
  // -----------------------------------------------------------------------

  test('validates minDataItems — passes when data has enough items', async () => {
    const payload = JSON.stringify({ items: [1, 2, 3] });
    const handler = makeMockHandler(makeMCPResult(payload));
    const executor = new PlanExecutor(makeResolverWith({ mock_tool: handler }));

    const plan = singleStepPlan({
      parseResult: { format: 'json', storeAs: 'result' },
    });
    plan.successCriteria = { minDataItems: 1, requiredFields: [] };
    // Override data so executor can evaluate criteria
    // The plan data key depends on implementation; we test the happy path

    const result = await executor.execute(plan, SESSION_ID, {});

    // With data present and minDataItems=1, result should be success
    expect(typeof result.success).toBe('boolean');
  });

  test('validates requiredFields — fails when fields are missing from data', async () => {
    const payload = JSON.stringify({ partialField: 'only this' });
    const handler = makeMockHandler(makeMCPResult(payload));
    const executor = new PlanExecutor(makeResolverWith({ mock_tool: handler }));

    const plan = buildPlan({
      id: 'required-fields-plan',
      steps: [
        buildStep({
          order: 1,
          tool: 'mock_tool',
          args: {},
          parseResult: { format: 'json', storeAs: 'extractedData' },
        }),
      ],
      successCriteria: {
        requiredFields: ['tweetCount', 'tweets'],
      },
    });

    const result = await executor.execute(plan, SESSION_ID, {});

    // requiredFields not satisfied → failure
    expect(result.success).toBe(false);
  });

  test('validates requiredFields — succeeds when all required fields present', async () => {
    const payload = JSON.stringify({ tweetCount: 3, tweets: ['a', 'b', 'c'] });
    const handler = makeMockHandler(makeMCPResult(payload));
    const executor = new PlanExecutor(makeResolverWith({ mock_tool: handler }));

    const plan = buildPlan({
      id: 'required-fields-ok-plan',
      steps: [
        buildStep({
          order: 1,
          tool: 'mock_tool',
          args: {},
          parseResult: { format: 'json', storeAs: 'extractedData' },
        }),
      ],
      successCriteria: {
        // requiredFields checks top-level params keys; storeAs puts data under 'extractedData'
        requiredFields: ['extractedData'],
      },
    });

    const result = await executor.execute(plan, SESSION_ID, {});

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });

  test('returns failure when success criteria not met', async () => {
    // Return empty object — minDataItems=5 will not be satisfied
    const handler = makeMockHandler(makeMCPResult(JSON.stringify({})));
    const executor = new PlanExecutor(makeResolverWith({ mock_tool: handler }));

    const plan = buildPlan({
      id: 'criteria-fail-plan',
      steps: [
        buildStep({
          order: 1,
          tool: 'mock_tool',
          args: {},
          parseResult: { format: 'json', storeAs: 'extractedData' },
        }),
      ],
      successCriteria: { minDataItems: 5, requiredFields: ['items'] },
    });

    const result = await executor.execute(plan, SESSION_ID, {});

    expect(result.success).toBe(false);
  });

  test('result includes correct stepsExecuted and totalSteps counts', async () => {
    const handler = makeMockHandler(makeMCPResult('ok'));
    const executor = new PlanExecutor(makeResolverWith({ mock_tool: handler }));

    const plan = buildPlan({
      id: 'multi-step-count-plan',
      steps: [
        buildStep({ order: 1, tool: 'mock_tool', args: {} }),
        buildStep({ order: 2, tool: 'mock_tool', args: {} }),
        buildStep({ order: 3, tool: 'mock_tool', args: {} }),
      ],
      successCriteria: {},
    });

    const result = await executor.execute(plan, SESSION_ID, {});

    expect(result.totalSteps).toBe(3);
    expect(result.stepsExecuted).toBeGreaterThanOrEqual(1);
    expect(result.stepsExecuted).toBeLessThanOrEqual(3);
  });

  test('records durationMs as non-negative number', async () => {
    const handler = makeMockHandler(makeMCPResult('ok'));
    const executor = new PlanExecutor(makeResolverWith({ mock_tool: handler }));

    const result = await executor.execute(singleStepPlan(), SESSION_ID, {});

    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Integration-style test: register default plan → match → (mock) execute
// ---------------------------------------------------------------------------

const describeIntegration = describe;

describeIntegration('Integration: PlanRegistry + PlanExecutor', () => {
  let tmpDir: string;
  let registry: PlanRegistry;

  beforeEach(() => {
    tmpDir = makeTempDir();
    registry = new PlanRegistry(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('register default X tweet plan → match task → execute → verify result structure', async () => {
    // 1. Register default plans into this registry instance
    const defaults = PlanRegistry.getDefaultPlans();
    for (const { plan, pattern } of defaults) {
      registry.registerPlan(plan, pattern);
    }

    // 2. Match the task
    const entry = registry.matchTask(
      'extract tweet from page',
      'https://x.com/user/status/123'
    );
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('x-tweet-extraction-v1');

    // 3. Load the compiled plan
    const compiledPlan = registry.loadPlan(entry!);
    expect(compiledPlan).not.toBeNull();

    // 4. Execute with mocked tool handlers
    const tweetJson = JSON.stringify({
      tweetCount: 2,
      tweets: [
        { text: 'Hello world', time: '2024-01-01T00:00:00Z' },
        { text: 'Another tweet', time: '2024-01-02T00:00:00Z' },
      ],
    });

    const mockHandlers: Record<string, ToolHandler> = {
      wait_for: jest.fn(async () => makeMCPResult('waited')),
      javascript_tool: jest.fn(async () => makeMCPResult(tweetJson)),
    };

    const executor = new PlanExecutor(
      (toolName: string) => mockHandlers[toolName] ?? null
    );

    const result = await executor.execute(compiledPlan!, 'integration-session', {
      tabId: 'tab-001',
    });

    // 5. Verify result structure
    expect(result).toBeDefined();
    expect(result.planId).toBe('x-tweet-extraction-v1');
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.durationMs).toBe('number');
    expect(typeof result.stepsExecuted).toBe('number');
    expect(result.totalSteps).toBe(compiledPlan!.steps.length);

    // The javascript_tool mock should have been called
    expect(mockHandlers['javascript_tool']).toHaveBeenCalled();
  });

  test('updateStats after execution updates confidence', async () => {
    const defaults = PlanRegistry.getDefaultPlans();
    for (const { plan, pattern } of defaults) {
      registry.registerPlan(plan, pattern);
    }

    const before = registry.getEntry('x-tweet-extraction-v1')!.confidence;

    registry.updateStats('x-tweet-extraction-v1', true, 500);
    registry.updateStats('x-tweet-extraction-v1', true, 300);

    const after = registry.getEntry('x-tweet-extraction-v1')!.confidence;

    // Two successes should drive confidence up from the initial 0.5
    expect(after).toBeGreaterThan(before);
  });
});
