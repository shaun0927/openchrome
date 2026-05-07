/**
 * OpenAI Chat Completions voting provider.
 *
 * Minimal HTTP wrapper — no SDK dep. Pinned to the Chat Completions
 * endpoint at https://platform.openai.com/docs/api-reference/chat.
 * `OPENAI_API_KEY` env var or constructor `apiKey`. Optional `baseUrl`
 * supports OpenAI-compatible providers (Azure OpenAI, OpenRouter,
 * vLLM, Ollama) without additional code.
 */

import {
  classifyFetchException,
  fetchWithTimeout,
  normalizeHttpError,
  runWithReplyParse,
} from './http-helpers';
import type { VotingProvider, VoteRequest, ProviderReply } from '../orchestrator';

export interface OpenAIProviderOptions {
  apiKey?: string;
  model: string;
  maxOutputTokens?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MAX_OUTPUT_TOKENS = 512;

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAIVotingProvider implements VotingProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIProviderOptions) {
    this.model = opts.model;
    this.name = `openai:${opts.model}`;
    const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('OpenAIVotingProvider: apiKey or OPENAI_API_KEY is required');
    }
    this.apiKey = key;
    this.maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async ask(req: VoteRequest, opts: { timeoutMs: number }): Promise<ProviderReply> {
    return runWithReplyParse(async (prompt) => this.request(prompt, opts.timeoutMs), req);
  }

  private async request(
    prompt: string,
    timeoutMs: number,
  ): Promise<{ ok: true; text: string; tokens?: number } | { ok: false; error: { kind: 'timeout' | 'rate_limit' | 'auth' | 'malformed' | 'network' | 'unknown'; raw: string } }> {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        this.baseUrl,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: this.maxOutputTokens,
            messages: [
              {
                role: 'system',
                content:
                  'You are a careful agent. Reply only with a single JSON object describing the next action.',
              },
              { role: 'user', content: prompt },
            ],
          }),
        },
        timeoutMs,
        this.fetchImpl,
      );
    } catch (e) {
      return { ok: false, error: classifyFetchException(e) };
    }

    if (!res.ok) {
      const body = await safeText(res);
      return { ok: false, error: normalizeHttpError(res.status, body) };
    }

    let parsed: ChatCompletion;
    try {
      parsed = (await res.json()) as ChatCompletion;
    } catch (e) {
      return { ok: false, error: { kind: 'malformed', raw: 'response was not JSON' } };
    }
    const text = parsed.choices?.[0]?.message?.content ?? '';
    const tokens =
      (parsed.usage?.prompt_tokens ?? 0) + (parsed.usage?.completion_tokens ?? 0);
    return { ok: true, text, tokens };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 1000);
  } catch {
    return '';
  }
}
