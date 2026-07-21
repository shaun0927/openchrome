/// <reference types="jest" />
/**
 * Tests for action-cache self-heal (Stagehand idiom port).
 *
 * The self-heal loop reads and writes the v2 action cache. We mock
 * domain-memory the same way action-cache.test.ts does so cache state
 * is deterministic between tests.
 */

import { ParsedAction } from '../../src/actions/action-parser';

// ─── Mock domain-memory so cache reads/writes hit an in-memory store ───

jest.mock('../../src/memory/domain-memory', () => {
  const { DomainMemory } = jest.requireActual('../../src/memory/domain-memory');
  const instance = new DomainMemory();
  return {
    DomainMemory,
    extractDomainFromUrl: (url: string) => {
      try { return new URL(url).hostname; } catch { return ''; }
    },
    getDomainMemory: () => instance,
  };
});

beforeEach(() => {
  jest.resetModules();
  jest.mock('../../src/memory/domain-memory', () => {
    const { DomainMemory } = jest.requireActual('../../src/memory/domain-memory');
    const instance = new DomainMemory();
    return {
      DomainMemory,
      extractDomainFromUrl: (url: string) => {
        try { return new URL(url).hostname; } catch { return ''; }
      },
      getDomainMemory: () => instance,
    };
  });
});

function loadSelfHeal() {
  return require('../../src/actions/self-heal') as typeof import('../../src/actions/self-heal');
}

function loadCache() {
  return require('../../src/actions/action-cache') as typeof import('../../src/actions/action-cache');
}

const TEST_URL = 'https://example.com/login';
const TEST_INSTRUCTION = 'sign in';

function makeKeyParts(instruction = TEST_INSTRUCTION) {
  const cache = loadCache();
  const parts = cache.buildActionCacheKeyV2Parts({
    url: TEST_URL,
    instruction,
    actionKinds: ['click', 'fill'],
    viewport: { width: 1280, height: 800 },
    pageFingerprint: 'fp1',
    optionFingerprint: 'opt1',
  });
  if (!parts) throw new Error('test fixture: buildActionCacheKeyV2Parts returned null');
  return parts;
}

const PLANNED_ACTIONS: ParsedAction[] = [
  { action: 'click', target: 'sign in' },
];

const HEAL_ACTIONS: ParsedAction[] = [
  { action: 'click', target: 'log in link' },
  { action: 'type', target: 'email', value: 'x' },
];

describe('runActionWithSelfHeal — cold plan', () => {
  it('cache miss → plan → execute → cache on success', async () => {
    const { runActionWithSelfHeal } = loadSelfHeal();
    const cache = loadCache();
    const keyParts = makeKeyParts();

    const plan = jest.fn().mockResolvedValue(PLANNED_ACTIONS);
    const execute = jest.fn().mockResolvedValue(true);

    const result = await runActionWithSelfHeal({
      url: TEST_URL,
      instruction: TEST_INSTRUCTION,
      keyParts,
      plan,
      execute,
    });

    expect(result.outcome).toBe('planned');
    expect(result.cacheStatus).toBe('MISS');
    expect(result.invokedPlanner).toBe(true);
    expect(result.wroteCache).toBe(true);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(PLANNED_ACTIONS, 'planned');
    // Confirm cache write took effect.
    const cached = cache.getCachedSequenceV2(TEST_URL, TEST_INSTRUCTION, keyParts);
    expect(cached?.actions).toEqual(PLANNED_ACTIONS);
  });

  it('cache miss → plan → execute fails → plan_failure (no cache write)', async () => {
    const { runActionWithSelfHeal } = loadSelfHeal();
    const cache = loadCache();
    const keyParts = makeKeyParts();

    const plan = jest.fn().mockResolvedValue(PLANNED_ACTIONS);
    const execute = jest.fn().mockResolvedValue(false);

    const result = await runActionWithSelfHeal({
      url: TEST_URL,
      instruction: TEST_INSTRUCTION,
      keyParts,
      plan,
      execute,
    });

    expect(result.outcome).toBe('plan_failure');
    expect(result.wroteCache).toBe(false);
    expect(plan).toHaveBeenCalledTimes(1);
    // Cache must remain empty because the plan failed — the decision returns
    // MISS with no actions rather than a null entry.
    const missDecision = cache.getCachedSequenceV2(TEST_URL, TEST_INSTRUCTION, keyParts);
    expect(missDecision.status).toBe('MISS');
    expect(missDecision.actions).toBeUndefined();
  });
});

describe('runActionWithSelfHeal — cache hit path', () => {
  it('cached success does NOT invoke planner', async () => {
    const { runActionWithSelfHeal } = loadSelfHeal();
    const cache = loadCache();
    const keyParts = makeKeyParts();

    // Seed the cache.
    cache.cacheSequenceV2(TEST_URL, TEST_INSTRUCTION, PLANNED_ACTIONS, keyParts);

    const plan = jest.fn();
    const execute = jest.fn().mockResolvedValue(true);

    const result = await runActionWithSelfHeal({
      url: TEST_URL,
      instruction: TEST_INSTRUCTION,
      keyParts,
      plan,
      execute,
    });

    expect(result.outcome).toBe('hit');
    expect(result.cacheStatus).toBe('HIT');
    expect(result.invokedPlanner).toBe(false);
    expect(plan).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(PLANNED_ACTIONS, 'cached');
  });

  it('cached failure → re-plan → succeeds → heal_success', async () => {
    const { runActionWithSelfHeal } = loadSelfHeal();
    const cache = loadCache();
    const keyParts = makeKeyParts();

    cache.cacheSequenceV2(TEST_URL, TEST_INSTRUCTION, PLANNED_ACTIONS, keyParts);

    const plan = jest.fn(async (ctx) => {
      // Self-heal must pass the failed cache into the planner so the LLM
      // can steer around whatever changed on the page.
      expect(ctx.failedCache).toEqual(PLANNED_ACTIONS);
      return HEAL_ACTIONS;
    });
    const execute = jest.fn()
      .mockResolvedValueOnce(false) // cached run fails
      .mockResolvedValueOnce(true); // planned run succeeds

    const result = await runActionWithSelfHeal({
      url: TEST_URL,
      instruction: TEST_INSTRUCTION,
      keyParts,
      plan,
      execute,
    });

    expect(result.outcome).toBe('heal_success');
    expect(result.invokedPlanner).toBe(true);
    expect(result.wroteCache).toBe(true);
    expect(execute).toHaveBeenNthCalledWith(1, PLANNED_ACTIONS, 'cached');
    expect(execute).toHaveBeenNthCalledWith(2, HEAL_ACTIONS, 'planned');
    // Cache was overwritten with the successful heal.
    expect(cache.getCachedSequenceV2(TEST_URL, TEST_INSTRUCTION, keyParts)?.actions).toEqual(HEAL_ACTIONS);
  });

  it('cached failure → re-plan → still fails → heal_failure', async () => {
    const { runActionWithSelfHeal } = loadSelfHeal();
    const cache = loadCache();
    const keyParts = makeKeyParts();

    cache.cacheSequenceV2(TEST_URL, TEST_INSTRUCTION, PLANNED_ACTIONS, keyParts);

    const plan = jest.fn().mockResolvedValue(HEAL_ACTIONS);
    const execute = jest.fn().mockResolvedValue(false);

    const result = await runActionWithSelfHeal({
      url: TEST_URL,
      instruction: TEST_INSTRUCTION,
      keyParts,
      plan,
      execute,
    });

    expect(result.outcome).toBe('heal_failure');
    expect(result.wroteCache).toBe(false);
  });

  it('healOnFailure=false skips the LLM re-plan on cached failure', async () => {
    const { runActionWithSelfHeal } = loadSelfHeal();
    const cache = loadCache();
    const keyParts = makeKeyParts();

    cache.cacheSequenceV2(TEST_URL, TEST_INSTRUCTION, PLANNED_ACTIONS, keyParts);

    const plan = jest.fn();
    const execute = jest.fn().mockResolvedValue(false);

    const result = await runActionWithSelfHeal({
      url: TEST_URL,
      instruction: TEST_INSTRUCTION,
      keyParts,
      plan,
      execute,
      healOnFailure: false,
    });

    expect(result.outcome).toBe('heal_failure');
    expect(plan).not.toHaveBeenCalled();
  });

  it('bypassCache=true skips the cache read and always plans', async () => {
    const { runActionWithSelfHeal } = loadSelfHeal();
    const cache = loadCache();
    const keyParts = makeKeyParts();

    cache.cacheSequenceV2(TEST_URL, TEST_INSTRUCTION, PLANNED_ACTIONS, keyParts);

    const plan = jest.fn().mockResolvedValue(HEAL_ACTIONS);
    const execute = jest.fn().mockResolvedValue(true);

    const result = await runActionWithSelfHeal({
      url: TEST_URL,
      instruction: TEST_INSTRUCTION,
      keyParts,
      plan,
      execute,
      bypassCache: true,
    });

    expect(result.outcome).toBe('planned');
    expect(result.cacheStatus).toBe('BYPASS');
    expect(plan).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(HEAL_ACTIONS, 'planned');
    // Cache was written despite bypass (bypass only skips READ).
    expect(cache.getCachedSequenceV2(TEST_URL, TEST_INSTRUCTION, keyParts)?.actions).toEqual(HEAL_ACTIONS);
  });
});

describe('SelfHealCounters helpers', () => {
  it('emptyCounters / bumpCounter / cacheHitRate', () => {
    const { emptyCounters, bumpCounter, cacheHitRate } = loadSelfHeal();
    const c = emptyCounters();
    expect(cacheHitRate(c)).toBeUndefined();

    bumpCounter(c, 'hit');
    bumpCounter(c, 'hit');
    bumpCounter(c, 'hit');
    bumpCounter(c, 'planned');

    expect(c.hit).toBe(3);
    expect(c.planned).toBe(1);
    expect(cacheHitRate(c)).toBe(0.75);
  });

  it('cacheHitRate treats heal_success as an LLM invocation (denominator)', () => {
    const { emptyCounters, bumpCounter, cacheHitRate } = loadSelfHeal();
    const c = emptyCounters();
    bumpCounter(c, 'hit');
    bumpCounter(c, 'heal_success');
    // 1 hit / 2 total = 0.5. Self-heals count against the hit rate because
    // they involved the LLM planner even though the outcome was recovery.
    expect(cacheHitRate(c)).toBe(0.5);
  });
});
