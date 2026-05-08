/**
 * Shared HTTP helpers for voting providers.
 *
 * Both anthropic.ts and openai.ts wrap their respective Messages /
 * Chat Completions API with the absolute-minimum dependencies (just
 * Node 18+'s built-in `fetch`) and the same parse + retry policy from
 * #711 v2:
 *
 *   1. Send the prompt with a JSON-only instruction.
 *   2. Parse with `extractFirstJsonObject` — handles markdown ```json
 *      fences, leading prose, and balanced-brace nested objects.
 *   3. On parse failure, retry ONCE with a stricter prompt:
 *      "You replied with non-JSON. Reply now with ONLY a JSON object."
 *   4. On second failure → provider failure (caller maps via the
 *      orchestrator's strict|graceful policy).
 */

import type { ProviderError, ProviderErrorKind, ProviderReply, VoteRequest } from '../orchestrator';
import { extractFirstJsonObject } from '../orchestrator';
import type { ActionInvocation } from '../args-equivalence';

/** Build the user-message text the provider sees. */
export function buildPrompt(req: VoteRequest, strict = false): string {
  const lines = [
    `Skill: ${req.skillName}`,
    `Intent: ${req.intent}`,
    `Allowed action kinds: ${req.allowedActionKinds.join(', ')}`,
    '',
    'Compressed DOM (truncated):',
    req.compressedDom.slice(0, 4000),
    '',
    strict
      ? 'You replied with non-JSON. Reply NOW with ONLY a JSON object — no markdown, no prose. Shape: {"action": <kind>, "args": <object>}'
      : 'Decide the next action this skill should take. Reply STRICTLY as a JSON object: {"action": <kind>, "args": <object>}',
  ];
  return lines.join('\n');
}

export interface NormalizedHttpError {
  kind: ProviderErrorKind;
  raw: string;
}

/** Map a fetch failure / non-2xx response into a normalized ProviderError. */
export function normalizeHttpError(status: number, body: string): NormalizedHttpError {
  let kind: ProviderErrorKind = 'unknown';
  if (status === 0) kind = 'network';
  else if (status === 408 || status === 504) kind = 'timeout';
  else if (status === 401 || status === 403) kind = 'auth';
  else if (status === 429) kind = 'rate_limit';
  else if (status >= 500) kind = 'unknown';
  else kind = 'malformed';
  return { kind, raw: body.slice(0, 500) };
}

/** Wrap a fetch call with a hard timeout. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Convert an aborted-fetch error into a normalized "timeout". */
export function classifyFetchException(e: unknown): ProviderError {
  if (e instanceof Error) {
    if (e.name === 'AbortError') return { kind: 'timeout', raw: e.message };
    if ('code' in e && (e as NodeJS.ErrnoException).code) {
      const code = (e as NodeJS.ErrnoException).code!;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ENETUNREACH') {
        return { kind: 'network', raw: `${code}: ${e.message}` };
      }
    }
    return { kind: 'unknown', raw: e.message };
  }
  return { kind: 'unknown', raw: String(e) };
}

/**
 * Validate a parsed JSON envelope as `{action, args}`. Returns null
 * when the shape is wrong — caller treats null as a parse failure.
 */
export function asActionInvocation(parsed: unknown): ActionInvocation | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const kind = obj.action;
  if (typeof kind !== 'string' || kind.length === 0) return null;
  // args is optional — many actions take none
  const args = obj.args ?? {};
  if (typeof args !== 'object' || args === null) return null;
  return { kind, args };
}

/**
 * Common reply harness shared by both providers. Takes a function
 * that does ONE round-trip (the provider's HTTP call + raw text
 * extraction) and applies the parse + strict-retry policy.
 */
export async function runWithReplyParse(
  request: (prompt: string) => Promise<{ ok: true; text: string; tokens?: number } | { ok: false; error: ProviderError }>,
  req: VoteRequest,
): Promise<ProviderReply> {
  // First pass.
  const first = await request(buildPrompt(req, false));
  if (!first.ok) return { ok: false, error: first.error };

  const parsed = extractFirstJsonObject(first.text);
  const action = asActionInvocation(parsed);
  if (action) return { ok: true, action, tokens: first.tokens };

  // Retry once with a stricter prompt.
  const second = await request(buildPrompt(req, true));
  if (!second.ok) return { ok: false, error: second.error, tokens: first.tokens };

  const parsed2 = extractFirstJsonObject(second.text);
  const action2 = asActionInvocation(parsed2);
  if (action2) {
    return { ok: true, action: action2, tokens: (first.tokens ?? 0) + (second.tokens ?? 0) };
  }

  return {
    ok: false,
    // 8192-char cap: worst-case merge envelope is body(4000) + intent(512) +
    // name(64) + JSON overhead(~50) = ~4626 chars. 8192 gives ~4 KB headroom
    // against future cap increases while still bounding log spam.
    error: { kind: 'malformed', raw: second.text.slice(0, 8192) },
    tokens: (first.tokens ?? 0) + (second.tokens ?? 0),
  };
}
