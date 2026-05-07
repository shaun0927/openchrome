import {
  AnthropicVotingProvider,
  OpenAIVotingProvider,
  asActionInvocation,
  buildPrompt,
  classifyFetchException,
  normalizeHttpError,
} from '../../src/perception/voting/providers';
import type { VoteRequest } from '../../src/perception/voting';

const REQ: VoteRequest = {
  compressedDom: '<dom/>',
  skillName: 'test.skill',
  intent: 'click checkout',
  allowedActionKinds: ['click', 'navigate'],
};

/* ------------------------------------------------------------------ */
/* http-helpers                                                        */
/* ------------------------------------------------------------------ */

describe('asActionInvocation', () => {
  test('valid envelope → ActionInvocation', () => {
    expect(asActionInvocation({ action: 'click', args: { x: 1 } })).toEqual({
      kind: 'click',
      args: { x: 1 },
    });
  });

  test('default args = {} when omitted', () => {
    expect(asActionInvocation({ action: 'no_op' })).toEqual({ kind: 'no_op', args: {} });
  });

  test('rejects when action is missing / wrong type', () => {
    expect(asActionInvocation({})).toBeNull();
    expect(asActionInvocation({ action: 123 })).toBeNull();
    expect(asActionInvocation({ action: '' })).toBeNull();
  });

  test('rejects non-object args', () => {
    expect(asActionInvocation({ action: 'click', args: 'oops' })).toBeNull();
    expect(asActionInvocation({ action: 'click', args: null })).toEqual({ kind: 'click', args: {} });
  });
});

describe('buildPrompt', () => {
  test('strict mode flips the closing instruction', () => {
    const a = buildPrompt(REQ, false);
    const b = buildPrompt(REQ, true);
    expect(a).toContain('Decide the next action');
    expect(b).toContain('You replied with non-JSON');
  });

  test('truncates DOM at 4000 chars', () => {
    const big = 'X'.repeat(10_000);
    const out = buildPrompt({ ...REQ, compressedDom: big }, false);
    expect(out).toContain('X'.repeat(4000));
    expect(out).not.toContain('X'.repeat(4001));
  });
});

describe('normalizeHttpError', () => {
  test('classifies common HTTP statuses', () => {
    expect(normalizeHttpError(401, 'unauthorized').kind).toBe('auth');
    expect(normalizeHttpError(403, 'forbidden').kind).toBe('auth');
    expect(normalizeHttpError(429, 'rate').kind).toBe('rate_limit');
    expect(normalizeHttpError(500, 'oops').kind).toBe('unknown');
    expect(normalizeHttpError(504, 'gateway').kind).toBe('timeout');
    expect(normalizeHttpError(400, 'bad').kind).toBe('malformed');
    expect(normalizeHttpError(0, 'network').kind).toBe('network');
  });

  test('truncates raw body to 500 chars', () => {
    const big = 'A'.repeat(2000);
    expect(normalizeHttpError(500, big).raw.length).toBe(500);
  });
});

describe('classifyFetchException', () => {
  test('AbortError → timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyFetchException(err).kind).toBe('timeout');
  });

  test('ECONNREFUSED → network', () => {
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(classifyFetchException(err).kind).toBe('network');
  });

  test('plain error → unknown', () => {
    expect(classifyFetchException(new Error('weird')).kind).toBe('unknown');
  });

  test('non-error thrown value → unknown', () => {
    expect(classifyFetchException('weird').kind).toBe('unknown');
  });
});

/* ------------------------------------------------------------------ */
/* Mocked-fetch provider tests                                         */
/* ------------------------------------------------------------------ */

function makeFakeFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let i = 0;
  return (async (_url: string, _init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('AnthropicVotingProvider — mocked fetch', () => {
  test('happy path: parses Messages response into ActionInvocation', async () => {
    const fakeFetch = makeFakeFetch([
      {
        status: 200,
        body: {
          content: [{ type: 'text', text: '{"action":"click","args":{"x":100,"y":200}}' }],
          usage: { input_tokens: 50, output_tokens: 20 },
        },
      },
    ]);
    const p = new AnthropicVotingProvider({
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      fetchImpl: fakeFetch,
    });
    const r = await p.ask(REQ, { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action?.kind).toBe('click');
      expect(r.tokens).toBe(70);
    }
  });

  test('strips ```json fences via extractFirstJsonObject', async () => {
    const fakeFetch = makeFakeFetch([
      {
        status: 200,
        body: {
          content: [
            { type: 'text', text: '```json\n{"action":"navigate","args":{"url":"https://x"}}\n```' },
          ],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      },
    ]);
    const p = new AnthropicVotingProvider({
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      fetchImpl: fakeFetch,
    });
    const r = await p.ask(REQ, { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action?.kind).toBe('navigate');
  });

  test('on parse failure, retries once with stricter prompt', async () => {
    const fakeFetch = makeFakeFetch([
      {
        status: 200,
        body: {
          content: [{ type: 'text', text: 'I cannot answer that' }], // not JSON
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      },
      {
        status: 200,
        body: {
          content: [{ type: 'text', text: '{"action":"click","args":{}}' }],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      },
    ]);
    const p = new AnthropicVotingProvider({
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      fetchImpl: fakeFetch,
    });
    const r = await p.ask(REQ, { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action?.kind).toBe('click');
  });

  test('two parse failures → malformed error', async () => {
    const fakeFetch = makeFakeFetch([
      { status: 200, body: { content: [{ type: 'text', text: 'no json here' }] } },
      { status: 200, body: { content: [{ type: 'text', text: 'still no json' }] } },
    ]);
    const p = new AnthropicVotingProvider({
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      fetchImpl: fakeFetch,
    });
    const r = await p.ask(REQ, { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.kind).toBe('malformed');
  });

  test('429 → rate_limit error', async () => {
    const fakeFetch = makeFakeFetch([{ status: 429, body: 'rate limited' }]);
    const p = new AnthropicVotingProvider({
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      fetchImpl: fakeFetch,
    });
    const r = await p.ask(REQ, { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.kind).toBe('rate_limit');
  });

  test('throws when API key is missing', () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(
        () =>
          new AnthropicVotingProvider({
            model: 'claude-haiku-4-5',
            fetchImpl: makeFakeFetch([]),
          }),
      ).toThrow(/apiKey/);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test('provider name includes model id', () => {
    const p = new AnthropicVotingProvider({
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      fetchImpl: makeFakeFetch([]),
    });
    expect(p.name).toBe('anthropic:claude-haiku-4-5');
  });
});

describe('OpenAIVotingProvider — mocked fetch', () => {
  test('happy path: parses Chat Completion → ActionInvocation', async () => {
    const fakeFetch = makeFakeFetch([
      {
        status: 200,
        body: {
          choices: [{ message: { content: '{"action":"click","args":{"x":1,"y":2}}' } }],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        },
      },
    ]);
    const p = new OpenAIVotingProvider({
      apiKey: 'sk-test',
      model: 'gpt-4.1-mini',
      fetchImpl: fakeFetch,
    });
    const r = await p.ask(REQ, { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action?.kind).toBe('click');
      expect(r.tokens).toBe(70);
    }
  });

  test('401 → auth error', async () => {
    const fakeFetch = makeFakeFetch([{ status: 401, body: 'invalid api key' }]);
    const p = new OpenAIVotingProvider({
      apiKey: 'sk-test',
      model: 'gpt-4.1-mini',
      fetchImpl: fakeFetch,
    });
    const r = await p.ask(REQ, { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.kind).toBe('auth');
  });

  test('500 → unknown error (server-side)', async () => {
    const fakeFetch = makeFakeFetch([{ status: 500, body: 'internal' }]);
    const p = new OpenAIVotingProvider({
      apiKey: 'sk-test',
      model: 'gpt-4.1-mini',
      fetchImpl: fakeFetch,
    });
    const r = await p.ask(REQ, { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error?.kind).toBe('unknown');
  });

  test('honors a custom baseUrl (proxies / OpenAI-compatible servers)', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"x"}' } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const p = new OpenAIVotingProvider({
      apiKey: 'sk-test',
      model: 'local-llama',
      baseUrl: 'http://127.0.0.1:11434/v1/chat/completions',
      fetchImpl: fakeFetch,
    });
    await p.ask(REQ, { timeoutMs: 5000 });
    expect(calls[0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  test('provider name includes model id', () => {
    const p = new OpenAIVotingProvider({
      apiKey: 'sk-test',
      model: 'gpt-4.1-mini',
      fetchImpl: makeFakeFetch([]),
    });
    expect(p.name).toBe('openai:gpt-4.1-mini');
  });
});
