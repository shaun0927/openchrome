/**
 * DeepResearch Bench browser-side runner tests.
 */

import {
  aggregateDeepResearch,
  matchesRegistrableDomain,
  runDeepResearchTask,
  type BrowserSession,
  type DeepResearchStep,
} from './runner';
import type { DeepResearchTask } from './loader';

function mkTask(over: Partial<DeepResearchTask> = {}): DeepResearchTask {
  return {
    task_id: 't-1',
    language: 'en',
    domain: 'Science',
    query: 'query',
    expected_sources: [
      'https://www.nature.com/article-a',
      'https://pubmed.ncbi.nlm.nih.gov/xyz',
    ],
    reference_steps: 4,
    ...over,
  };
}

function mkSession(
  responses: Record<string, string | Error>,
  tokens = 100,
): BrowserSession {
  let currentUrl = 'about:blank';
  return {
    async navigate(url: string) {
      const outcome = responses[url];
      if (outcome instanceof Error) throw outcome;
      currentUrl = outcome ?? url;
      return currentUrl;
    },
    async visibleLinks() {
      return [];
    },
    async followLink(href: string) {
      currentUrl = href;
    },
    async currentUrl() {
      return currentUrl;
    },
    observationTokens() {
      return tokens;
    },
  };
}

describe('matchesRegistrableDomain', () => {
  it('matches www vs bare host', () => {
    expect(matchesRegistrableDomain('https://www.example.com/a', 'https://example.com/b')).toBe(true);
  });

  it('rejects unrelated hosts', () => {
    expect(matchesRegistrableDomain('https://a.com/', 'https://b.com/')).toBe(false);
  });

  it('handles two-label ccTLDs', () => {
    expect(matchesRegistrableDomain('https://www.foo.co.uk/', 'https://docs.foo.co.uk/')).toBe(true);
  });

  it('returns false for malformed URLs', () => {
    expect(matchesRegistrableDomain('not-a-url', 'https://a.com')).toBe(false);
  });
});

describe('runDeepResearchTask', () => {
  it('visits every expected source and marks complete', async () => {
    const task = mkTask();
    const session = mkSession({
      [task.expected_sources[0]]: task.expected_sources[0],
      [task.expected_sources[1]]: task.expected_sources[1],
    });
    const result = await runDeepResearchTask(task, session);
    expect(result.complete).toBe(true);
    expect(result.sourceCoverage).toBe(1);
    expect(result.visited.length).toBe(2);
    expect(result.stopReason).toBe('complete');
  });

  it('records missed sources when navigate fails', async () => {
    const task = mkTask();
    const session = mkSession({
      [task.expected_sources[0]]: task.expected_sources[0],
      [task.expected_sources[1]]: new Error('boom'),
    });
    const result = await runDeepResearchTask(task, session);
    expect(result.complete).toBe(false);
    expect(result.missed).toEqual([task.expected_sources[1]]);
    expect(result.steps[1].ok).toBe(false);
  });

  it('stops when the step budget is exhausted', async () => {
    const task = mkTask({
      expected_sources: ['https://a.com/', 'https://b.com/', 'https://c.com/'],
    });
    const session = mkSession({
      'https://a.com/': 'https://a.com/',
      'https://b.com/': 'https://b.com/',
      'https://c.com/': 'https://c.com/',
    });
    const result = await runDeepResearchTask(task, session, { stepBudget: 2 });
    expect(result.steps.length).toBe(2);
    expect(result.stopReason).toBe('step_budget');
  });

  it('stops when the token budget is exhausted', async () => {
    const task = mkTask({
      expected_sources: ['https://a.com/', 'https://b.com/', 'https://c.com/'],
    });
    const session = mkSession(
      {
        'https://a.com/': 'https://a.com/',
        'https://b.com/': 'https://b.com/',
        'https://c.com/': 'https://c.com/',
      },
      600,
    );
    const result = await runDeepResearchTask(task, session, { tokenBudget: 1_000 });
    expect(result.steps.length).toBeLessThan(3);
    expect(['token_budget', 'complete']).toContain(result.stopReason);
  });

  it('emits onStep callbacks', async () => {
    const task = mkTask();
    const session = mkSession({
      [task.expected_sources[0]]: task.expected_sources[0],
      [task.expected_sources[1]]: task.expected_sources[1],
    });
    const events: DeepResearchStep[] = [];
    await runDeepResearchTask(task, session, { onStep: (s) => events.push(s) });
    expect(events.length).toBe(2);
    expect(events[0].action).toBe('navigate');
  });

  it('counts coverage 1.0 when a task has no expected sources', async () => {
    const task = mkTask({ expected_sources: [] });
    const session = mkSession({});
    const result = await runDeepResearchTask(task, session);
    expect(result.sourceCoverage).toBe(1);
    expect(result.complete).toBe(true);
  });
});

describe('aggregateDeepResearch', () => {
  it('rolls up by domain and computes mean coverage', () => {
    const agg = aggregateDeepResearch([
      {
        taskId: 't1',
        domain: 'Science',
        language: 'en',
        sourceCoverage: 1,
        visited: ['a'],
        missed: [],
        complete: true,
        steps: [],
        totalTokens: 100,
        totalElapsedMs: 200,
        stopReason: 'complete',
      },
      {
        taskId: 't2',
        domain: 'Science',
        language: 'en',
        sourceCoverage: 0.5,
        visited: ['a'],
        missed: ['b'],
        complete: false,
        steps: [],
        totalTokens: 100,
        totalElapsedMs: 200,
        stopReason: 'step_budget',
      },
      {
        taskId: 't3',
        domain: 'Finance',
        language: 'en',
        sourceCoverage: 0,
        visited: [],
        missed: ['a'],
        complete: false,
        steps: [],
        totalTokens: 0,
        totalElapsedMs: 0,
        stopReason: 'error',
      },
    ]);
    expect(agg.total).toBe(3);
    expect(agg.complete).toBe(1);
    expect(agg.meanCoverage).toBeCloseTo(0.5, 5);
    expect(agg.byDomain.Science.total).toBe(2);
    expect(agg.byDomain.Science.meanCoverage).toBeCloseTo(0.75, 5);
    expect(agg.byDomain.Finance.complete).toBe(0);
  });
});
