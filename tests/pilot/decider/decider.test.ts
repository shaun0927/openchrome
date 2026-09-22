import {
  OutboundDecisionBudget,
  MemoryDecisionRecorder,
  buildOpenAIChatDecisionRequest,
  buildTypeSafeDecisionRequest,
  createHostDecisionProvider,
  createNoopDecisionProvider,
  createTypeSafeDecisionProvider,
  decideWithBudget,
  parseOpenAIChatDecisionResponse,
  parseTypeSafeDecisionResponse,
} from '../../../src/pilot/decider';
import type { DecisionQuestion } from '../../../src/pilot/decider';

const question: DecisionQuestion = {
  id: 'q-1',
  instructions: 'Pick the next action.',
  choices: [
    { id: 'click_search', label: 'Click Search' },
    { id: 'none', label: 'No safe action' },
  ],
  state: { url: 'https://example.test/search' },
};

describe('pilot decider providers', () => {
  it('no-op always abstains under the shared contract', async () => {
    await expect(createNoopDecisionProvider().decide(question)).resolves.toMatchObject({
      provider: 'noop',
      answer: 'none',
      confidence: 0,
      abstain: true,
    });
  });

  it('host provider normalizes delegated answers', async () => {
    const host = createHostDecisionProvider(async () => ({ answer: 'click_search', confidence: 1.2, abstain: false }));
    await expect(host.decide(question)).resolves.toMatchObject({
      provider: 'host',
      answer: 'click_search',
      confidence: 1,
      abstain: false,
    });
  });

  it('TypeSafe request shape uses SystemOne choice criteria', () => {
    expect(buildTypeSafeDecisionRequest(question)).toMatchObject({
      model: 'jev-latest',
      state: question.state,
      questions: {
        q: {
          type: 'choice',
          instructions: 'Pick the next action.',
          criteria: {
            click_search: 'Click Search',
            none: 'No safe action',
            none_of_the_above: null,
          },
        },
      },
    });
  });

  it('TypeSafe provider downgrades without a key and does not call fetch', async () => {
    const calls: string[] = [];
    const provider = createTypeSafeDecisionProvider({
      apiKey: '',
      fetchImpl: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response('{}');
      }) as typeof fetch,
    });
    await expect(provider.decide(question)).resolves.toMatchObject({
      provider: 'typesafe',
      answer: 'none',
      downgraded: true,
      reason: 'no_key',
    });
    expect(calls).toEqual([]);
  });

  it('TypeSafe provider posts a request and parses the selected choice', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const provider = createTypeSafeDecisionProvider({
      apiKey: 'test-key',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ answers: { q: { choice: 'click_search', confidence: 0.82 } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    await expect(provider.decide(question)).resolves.toMatchObject({
      provider: 'typesafe',
      answer: 'click_search',
      confidence: 0.82,
      abstain: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0].body).toMatchObject({ model: 'jev-latest' });
  });

  it('TypeSafe provider accepts gateway endpoint and model overrides', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const provider = createTypeSafeDecisionProvider({
      apiKey: 'test-key',
      endpoint: 'https://gateway.example.test/typesafe',
      model: 'jev-gateway',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ results: { q: 'click_search' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    await expect(provider.decide(question)).resolves.toMatchObject({
      answer: 'click_search',
      abstain: false,
    });
    expect(calls[0]).toMatchObject({
      url: 'https://gateway.example.test/typesafe',
      body: { model: 'jev-gateway' },
    });
  });

  it('TypeSafe provider can use Vercel AI Gateway chat completions', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const provider = createTypeSafeDecisionProvider({
      apiKey: 'test-key',
      endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ q: { choice: 'click_search', confidence: 0.88 } }) } }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    await expect(provider.decide(question)).resolves.toMatchObject({
      answer: 'click_search',
      confidence: 0.88,
      abstain: false,
    });
    expect(calls[0]).toMatchObject({
      url: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      body: { model: 'typesafe-ai/jev', temperature: 0 },
    });
    expect(buildOpenAIChatDecisionRequest(question).messages[1].content).toContain('Criteria:');
    expect(parseOpenAIChatDecisionResponse('typesafe', { choices: [{ message: { content: 'click_search' } }] })).toMatchObject({ answer: 'click_search' });
  });

  it('parses probability-map responses and none_of_the_above', () => {
    expect(parseTypeSafeDecisionResponse('typesafe', { q: { click_search: 0.7, none: 0.2 } })).toMatchObject({
      answer: 'click_search',
      confidence: 0.7,
    });
    expect(parseTypeSafeDecisionResponse('typesafe', { results: { q: 'none_of_the_above' } })).toMatchObject({
      answer: 'none',
      abstain: true,
    });
  });
});

describe('pilot decider runner', () => {
  it('records primary decisions and external actual results', async () => {
    const recorder = new MemoryDecisionRecorder();
    const primary = createHostDecisionProvider(async () => ({ answer: 'click_search', confidence: 0.9, abstain: false }), 'primary');
    const fallback = createNoopDecisionProvider();
    const result = await decideWithBudget(question, {
      primary,
      fallback,
      budget: new OutboundDecisionBudget(1),
      recorder,
    }, { receipt: 'server-state-only' });
    expect(result.answer).toBe('click_search');
    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]).toMatchObject({
      provider: 'primary',
      question_id: 'q-1',
      answer: 'click_search',
      actual_result: { receipt: 'server-state-only' },
    });
  });

  it('downgrades to fallback when the outbound budget is exhausted', async () => {
    const recorder = new MemoryDecisionRecorder();
    const primary = createHostDecisionProvider(async () => ({ answer: 'click_search', confidence: 0.9, abstain: false }), 'primary');
    const fallback = createNoopDecisionProvider();
    const budget = new OutboundDecisionBudget(0);
    await expect(decideWithBudget(question, { primary, fallback, budget, recorder })).resolves.toMatchObject({
      provider: 'noop',
      answer: 'none',
      downgraded: true,
      reason: 'outbound_budget_exhausted',
    });
    expect(recorder.records[0]).toMatchObject({
      provider: 'noop',
      downgraded: true,
      reason: 'outbound_budget_exhausted',
    });
  });

  it('downgrades to fallback when the primary provider cannot run', async () => {
    const primary = createTypeSafeDecisionProvider({ apiKey: '' });
    const fallback = createHostDecisionProvider(async () => ({ answer: 'click_search', confidence: 0.75, abstain: false }), 'host');
    await expect(decideWithBudget(question, { primary, fallback, budget: new OutboundDecisionBudget(1) })).resolves.toMatchObject({
      provider: 'host',
      answer: 'click_search',
      downgraded: true,
      reason: 'no_key',
    });
  });
});
