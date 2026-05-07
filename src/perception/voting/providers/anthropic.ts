/**
 * Anthropic Messages API voting provider.
 *
 * Minimal HTTP wrapper — no SDK dep. Pinned to the Messages endpoint
 * as documented at https://docs.anthropic.com/en/api/messages. The
 * only externalities are `fetch` (Node 18+) and the env var
 * `ANTHROPIC_API_KEY` (or override via the `apiKey` option).
 *
 * The provider is itself stateless — the orchestrator's
 * VotingSessionBudget tracks tokens across requests.
 */

import {
  asActionInvocation,
  buildPrompt,
  classifyFetchException,
  fetchWithTimeout,
  normalizeHttpError,
  runWithReplyParse,
} from './http-helpers';
import type { VotingProvider, VoteRequest, ProviderReply } from '../orchestrator';

export interface AnthropicProviderOptions {
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Model id (e.g. `claude-haiku-4-5`). */
  model: string;
  /** Soft cap per response. */
  maxOutputTokens?: number;
  /** Override the API base — useful for proxies + tests. */
  baseUrl?: string;
  /** Override fetch — tests inject a mock without monkeypatching globals. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_OUTPUT_TOKENS = 512;

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicVotingProvider implements VotingProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model;
    this.name = `anthropic:${opts.model}`;
    const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error('AnthropicVotingProvider: apiKey or ANTHROPIC_API_KEY is required');
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
            'x-api-key': this.apiKey,
            'anthropic-version': DEFAULT_ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: this.maxOutputTokens,
            messages: [{ role: 'user', content: prompt }],
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

    let parsed: MessagesResponse;
    try {
      parsed = (await res.json()) as MessagesResponse;
    } catch (e) {
      return { ok: false, error: { kind: 'malformed', raw: 'response was not JSON' } };
    }
    const text = (parsed.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('\n');
    const tokens =
      (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.output_tokens ?? 0);
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

// Re-export the helper composers so callers can build their own
// providers against the same parse/retry semantics.
export { asActionInvocation, buildPrompt };
