/**
 * HTTP voting providers.
 *
 * Both `AnthropicVotingProvider` and `OpenAIVotingProvider` are
 * minimal — no SDK deps, just Node 18+'s built-in `fetch`. They share
 * the parse + strict-retry policy via `http-helpers.ts`. Hosts pick
 * which providers to construct (typically two from different vendors)
 * and pass them to `VotingOrchestrator`.
 */

export { AnthropicVotingProvider, type AnthropicProviderOptions } from './anthropic';
export { OpenAIVotingProvider, type OpenAIProviderOptions } from './openai';

export {
  asActionInvocation,
  buildPrompt,
  classifyFetchException,
  fetchWithTimeout,
  normalizeHttpError,
  runWithReplyParse,
} from './http-helpers';
