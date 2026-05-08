/**
 * LLM-driven `MergeRequester` for curator Pass 2 (#715 v2).
 *
 * Wraps any `VotingProvider` (concrete: AnthropicVotingProvider /
 * OpenAIVotingProvider) and adapts its `ask(req)` surface to the
 * curator's `MergeRequester(req)` shape. The reply parse + strict-
 * retry policy is reused verbatim from `runWithReplyParse` in the
 * voting providers — same JSON-only instruction, same retry-once
 * fallback. The only difference is the prompt text and the JSON
 * envelope shape (`{name, intent, body}` instead of `{action, args}`).
 *
 * The provider remains usable for voting too — this module just adds
 * a second-path adapter.
 */

import type {
  ProviderReply,
  VotingProvider,
} from '../perception/voting/orchestrator';
import { extractFirstJsonObject } from '../perception/voting/orchestrator';
import type {
  MergeRequest,
  MergeRequester,
  MergeResult,
} from './curator-pass2';

const MAX_BODY_BYTES = 4000;
const MAX_INTENT_BYTES = 512;

/** Validate the parsed JSON envelope as a MergeResultOk shell. */
function asMergeOk(parsed: unknown): MergeResult | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const name = obj.name;
  const intent = obj.intent;
  const body = obj.body;
  if (typeof name !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(name)) return null;
  if (typeof intent !== 'string' || intent.length === 0) return null;
  if (typeof body !== 'string') return null;
  return {
    ok: true,
    name,
    intent: intent.slice(0, MAX_INTENT_BYTES),
    body: body.slice(0, MAX_BODY_BYTES),
  };
}

/** Build the LLM prompt from a cluster of sibling skills. */
export function buildMergePrompt(req: MergeRequest, strict = false): string {
  const lines = [
    `You are merging ${req.cluster.length} sibling skill descriptions for the same domain ("${req.domain}").`,
    'Produce a single umbrella skill that captures every variant. Pick the simplest name and intent that subsumes the cluster.',
    '',
    'Reply STRICTLY as JSON with this shape:',
    '  {"name": "<a-z0-9._-, max 64>", "intent": "<≤512 chars>", "body": "<Markdown body, ≤4000 chars>"}',
    '',
    'Sibling skills:',
  ];
  for (const r of req.cluster) {
    lines.push(`- name="${r.frontmatter.name}", intent="${r.frontmatter.intent}", verified_runs=${r.frontmatter.verified_runs}`);
  }
  if (strict) {
    lines.push('');
    lines.push('You replied with non-JSON. Reply NOW with ONLY a JSON object — no markdown, no prose.');
  }
  return lines.join('\n');
}

export interface CreateLlmMergeRequesterOptions {
  /** Voting provider to dispatch the prompt through. */
  provider: VotingProvider;
  /** Per-request timeout. Default 10s — merges may run longer than votes. */
  timeoutMs?: number;
  /**
   * Allowed action kinds passed to the underlying provider's ask() —
   * it expects this field but we don't actually pick an action; pass
   * `['merge']` so the provider has a non-empty list to surface in
   * the prompt. Override only if you've customized the provider.
   */
  allowedActionKinds?: string[];
}

/**
 * Build a `MergeRequester` that calls the provider with a merge
 * prompt and parses the JSON envelope. Returns ok:false (skip) on:
 *   - provider error
 *   - parsed JSON missing required fields
 *   - second strict-retry parse failure
 *
 * Either failure path emits a structured `reason` the curator records
 * in actions.jsonl.
 */
export function createLlmMergeRequester(
  opts: CreateLlmMergeRequesterOptions,
): MergeRequester {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const allowed = opts.allowedActionKinds ?? ['merge'];

  return async (req) => {
    // First attempt
    const first = await callOnce(opts.provider, req, timeoutMs, allowed, false);
    if (first.kind === 'ok') return first.result;
    if (first.kind === 'provider_error') {
      return {
        ok: false,
        reason: `merge provider error: kind=${first.error.kind} raw=${first.error.raw.slice(0, 120)}`,
      };
    }
    // Parse failure → strict retry once
    const second = await callOnce(opts.provider, req, timeoutMs, allowed, true);
    if (second.kind === 'ok') return second.result;
    if (second.kind === 'provider_error') {
      return {
        ok: false,
        reason: `merge provider error (strict retry): kind=${second.error.kind} raw=${second.error.raw.slice(0, 120)}`,
      };
    }
    return { ok: false, reason: 'merge_parse_failure: provider returned non-JSON twice' };
  };
}

type CallResult =
  | { kind: 'ok'; result: MergeResult }
  | { kind: 'parse_failure' }
  | { kind: 'provider_error'; error: { kind: string; raw: string } };

async function callOnce(
  provider: VotingProvider,
  req: MergeRequest,
  timeoutMs: number,
  allowed: string[],
  strict: boolean,
): Promise<CallResult> {
  const prompt = buildMergePrompt(req, strict);
  // Voting provider expects compressedDom + intent + skillName +
  // allowedActionKinds. We thread our merge prompt through `intent`
  // because it's the most natural carrier — the prompt is verbatim
  // what the LLM sees in the user message.
  const reply: ProviderReply = await provider.ask(
    {
      compressedDom: '<merge>',
      skillName: req.cluster[0]?.frontmatter.name ?? 'merge',
      intent: prompt,
      allowedActionKinds: allowed,
    },
    { timeoutMs },
  );
  // ok=true: provider parsed JSON and wrapped it in {action, args}.
  // Try to read a merge envelope from action.args directly.
  if (reply.ok && reply.action) {
    const ok = asMergeOk(reply.action.args);
    if (ok) return { kind: 'ok', result: ok };
  }
  // ok=false with kind='malformed': the provider parsed raw JSON but
  // asActionInvocation rejected it because the shape was {name,intent,body}
  // instead of {action,args}. Recover by parsing the raw text directly.
  if (!reply.ok && reply.error?.kind === 'malformed') {
    const parsed = extractFirstJsonObject(reply.error.raw);
    const ok = asMergeOk(parsed);
    if (ok) return { kind: 'ok', result: ok };
    return { kind: 'parse_failure' };
  }
  // Any other provider failure (timeout, rate_limit, auth, network, unknown)
  // is terminal — do not retry these as parse failures.
  if (!reply.ok) {
    return {
      kind: 'provider_error',
      error: { kind: reply.error?.kind ?? 'unknown', raw: reply.error?.raw ?? '' },
    };
  }
  // ok=true but no action — treat as parse failure (strict retry).
  return { kind: 'parse_failure' };
}

/**
 * Variant that bypasses the voting provider's asActionInvocation
 * gate by accepting a raw "ask the LLM and return the text" function.
 * Hosts that want clean merge-shape parsing without the action-shape
 * detour use this; voting providers that emit a free-text reply hook
 * up via a tiny adapter.
 */
export interface RawTextProvider {
  name: string;
  /** Returns the raw text reply or throws on hard failure. */
  ask(prompt: string, timeoutMs: number): Promise<{ ok: true; text: string; tokens?: number } | { ok: false; error: { kind: string; raw: string } }>;
}

export function createLlmMergeRequesterFromRawText(
  provider: RawTextProvider,
  opts: { timeoutMs?: number } = {},
): MergeRequester {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return async (req) => {
    const first = await provider.ask(buildMergePrompt(req, false), timeoutMs);
    if (!first.ok) {
      return {
        ok: false,
        reason: `merge provider error: kind=${first.error.kind} raw=${first.error.raw.slice(0, 120)}`,
      };
    }
    const parsed1 = extractFirstJsonObject(first.text);
    const ok1 = asMergeOk(parsed1);
    if (ok1) return ok1;

    const second = await provider.ask(buildMergePrompt(req, true), timeoutMs);
    if (!second.ok) {
      return {
        ok: false,
        reason: `merge provider error (strict retry): kind=${second.error.kind} raw=${second.error.raw.slice(0, 120)}`,
      };
    }
    const parsed2 = extractFirstJsonObject(second.text);
    const ok2 = asMergeOk(parsed2);
    if (ok2) return ok2;

    return { ok: false, reason: 'merge_parse_failure: provider returned non-JSON twice' };
  };
}
