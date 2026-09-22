/**
 * `typesafe` provider — POSTs each case to the TypeSafe SystemOne endpoint.
 *
 * Request shape (as specified for G0):
 *   {model:"jev-latest", state, questions:{q:{type:"choice", instructions,
 *     criteria:{<ref>:<label>, ..., none_of_the_above:null}}}}
 * with `Authorization: Bearer $TYPESAFE_API_KEY`.
 *
 * When the key is absent the provider reports `skipped: no key`; the
 * evaluator records that and exits 0. 429 / 529 responses back off
 * exponentially (honouring Retry-After when present) up to MAX_RETRIES.
 *
 * Response parsing is defensive because the response schema is not pinned:
 * the first of `answers.q`, `results.q`, `questions.q`, `q` is read, and the
 * choice is taken from `.choice`, `.answer`, `.value`, `.selected` (string) or
 * the highest-probability key of a `{choice: probability}` map. Confidence is
 * `.confidence` / `.probability` / that probability, else 0.5.
 */

import type {
  DecisionCase, ElementCase, GateCase, IrreversibleCase, OutcomeCase,
} from '../../../tests/fixtures/decisions/schema';
import { GATE_ANSWERS, IRREVERSIBLE_ANSWERS, OUTCOME_ANSWERS } from '../../../tests/fixtures/decisions/schema';
import type { DecisionProvider, ProviderAnswer, ProviderInit, ProviderOptions } from './types';
import { abstain, clamp01, NONE } from './types';

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_MODEL = 'jev-latest';
export const VERCEL_AI_GATEWAY_ENDPOINT = 'https://ai-gateway.vercel.sh/v1/chat/completions';
export const VERCEL_JEV_MODEL = 'typesafe-ai/jev';
export const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;
const NONE_OF_THE_ABOVE = 'none_of_the_above';
type TypeSafeProtocol = 'systemone' | 'openai-chat';

export interface TypeSafeQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface TypeSafeRequest {
  model: string;
  state: unknown;
  questions: { q: TypeSafeQuestion };
}

export interface OpenAIChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  temperature: number;
}

function criteriaFor(labels: readonly string[], describe: (l: string) => string): Record<string, string | null> {
  const criteria: Record<string, string | null> = {};
  for (const l of labels) criteria[l] = describe(l);
  criteria[NONE_OF_THE_ABOVE] = null;
  return criteria;
}

/** Build the request body for one case. Exported for tests. */
export function buildRequest(c: DecisionCase, model = TYPESAFE_MODEL): TypeSafeRequest {
  let q: TypeSafeQuestion;
  let state: unknown;
  switch (c.kind) {
    case 'element': {
      const e = c as ElementCase;
      state = { query: e.input.query, view: e.input.view };
      q = {
        type: 'choice',
        instructions: `Which target best matches the query "${e.input.query}"? Pick none_of_the_above if no target matches.`,
        criteria: criteriaFor(e.input.view.targets.map((t) => t.ref), (ref) => {
          const t = e.input.view.targets.find((x) => x.ref === ref)!;
          return `${t.role} "${t.name}"${t.value ? ` value="${t.value}"` : ''}${t.state ? ` [${t.state}]` : ''}`;
        }),
      };
      break;
    }
    case 'outcome': {
      const o = c as OutcomeCase;
      state = o.input;
      q = {
        type: 'choice',
        instructions: 'Given the DOM delta after an interaction, classify what actually happened.',
        criteria: criteriaFor(OUTCOME_ANSWERS, (l) => l),
      };
      break;
    }
    case 'irreversible': {
      const r = c as IrreversibleCase;
      state = r.input;
      q = {
        type: 'choice',
        instructions: 'Decide the policy gate for this tool call: allow it, or require a preview, an elicitation, a checkpoint, or block it.',
        criteria: criteriaFor(IRREVERSIBLE_ANSWERS, (l) => l),
      };
      break;
    }
    case 'gate': {
      const g = c as GateCase;
      state = g.input;
      q = {
        type: 'choice',
        instructions: 'Which access gate, if any, is blocking this page?',
        criteria: criteriaFor(GATE_ANSWERS.filter((l) => l !== NONE), (l) => l),
      };
      break;
    }
  }
  return { model, state, questions: { q } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Extract {answer, confidence} from a response body. Exported for tests. */
export function parseResponse(body: unknown, validChoices: readonly string[]): ProviderAnswer {
  if (!isRecord(body)) return abstain({ reason: 'non-object response', body });
  const container = [body.answers, body.results, body.questions, body]
    .find((x): x is Record<string, unknown> => isRecord(x) && 'q' in x);
  const q = container ? container.q : undefined;
  if (q === undefined) return abstain({ reason: 'no q in response', body });

  let choice: string | undefined;
  let confidence: number | undefined;
  if (typeof q === 'string') {
    choice = q;
  } else if (isRecord(q)) {
    for (const k of ['choice', 'answer', 'value', 'selected']) {
      if (typeof q[k] === 'string') { choice = q[k] as string; break; }
    }
    for (const k of ['confidence', 'probability', 'score']) {
      if (typeof q[k] === 'number') { confidence = q[k] as number; break; }
    }
    if (choice === undefined) {
      const probs = isRecord(q.probabilities) ? q.probabilities : q;
      let best: [string, number] | undefined;
      for (const [k, v] of Object.entries(probs)) {
        if (typeof v === 'number' && (validChoices.includes(k) || k === NONE_OF_THE_ABOVE) && (!best || v > best[1])) best = [k, v];
      }
      if (best) { choice = best[0]; confidence = confidence ?? best[1]; }
    }
  }
  if (choice === undefined) return abstain({ reason: 'no choice in response', body });
  const conf = clamp01(confidence ?? 0.5);
  if (choice === NONE_OF_THE_ABOVE || choice === NONE) return { answer: NONE, confidence: conf, abstain: true, raw: body };
  if (!validChoices.includes(choice)) return abstain({ reason: 'invalid choice' });
  return { answer: choice, confidence: conf, abstain: false, raw: body };
}

function protocolFromEndpoint(endpoint: string): TypeSafeProtocol {
  return endpoint.includes('/chat/completions') ? 'openai-chat' : 'systemone';
}

function choiceInstructions(request: TypeSafeRequest): string {
  return [
    request.questions.q.instructions,
    '',
    'Choose exactly one criterion id. Return JSON only in this shape:',
    '{"q":{"choice":"<criterion_id>","confidence":0.0}}',
    '',
    `Criteria: ${JSON.stringify(request.questions.q.criteria)}`,
    `State: ${JSON.stringify(request.state)}`,
  ].join('\n');
}

export function buildOpenAIChatRequest(c: DecisionCase, model = VERCEL_JEV_MODEL): OpenAIChatRequest {
  const request = buildRequest(c, model);
  return {
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: 'You are a fast structured decision model for browser automation. Return only machine-readable JSON.',
      },
      { role: 'user', content: choiceInstructions(request) },
    ],
  };
}

function parseContentAsResponse(content: string, validChoices: readonly string[]): ProviderAnswer {
  const trimmed = content.trim();
  try {
    return parseResponse(JSON.parse(trimmed), validChoices);
  } catch {
    const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (stripped !== trimmed) {
      try {
        return parseResponse(JSON.parse(stripped), validChoices);
      } catch {
      }
    }
  }
  const normalized = trimmed.replace(/^["']|["']$/g, '');
  if (validChoices.includes(normalized)) return { answer: normalized, confidence: 0.5, abstain: normalized === NONE, raw: { content } };
  if (normalized === NONE_OF_THE_ABOVE || normalized === NONE) return { answer: NONE, confidence: 0.5, abstain: true, raw: { content } };
  return abstain({ reason: 'chat content did not contain a valid choice', content });
}

export function parseOpenAIChatResponse(body: unknown, validChoices: readonly string[]): ProviderAnswer {
  if (!isRecord(body) || !Array.isArray(body.choices)) return abstain({ reason: 'non-chat response', body });
  const first = body.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== 'string') {
    return abstain({ reason: 'missing chat content', body });
  }
  const parsed = parseContentAsResponse(first.message.content, validChoices);
  return { ...parsed, raw: parsed.raw ?? body };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTypeSafeProvider(opts: ProviderOptions = {}): DecisionProvider {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.AI_GATEWAY_API_KEY;
  const endpoint = opts.endpoint ?? process.env.TYPESAFE_ENDPOINT ?? TYPESAFE_ENDPOINT;
  const protocol = opts.protocol ?? (process.env.TYPESAFE_PROTOCOL as TypeSafeProtocol | undefined) ?? protocolFromEndpoint(endpoint);
  const model = process.env.TYPESAFE_MODEL ?? (protocol === 'openai-chat' ? VERCEL_JEV_MODEL : TYPESAFE_MODEL);
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  const sleep = opts.sleep ?? defaultSleep;

  return {
    name: 'typesafe',
    async init(): Promise<ProviderInit | void> {
      if (!apiKey) return { skipped: 'no key' };
      if (!fetchImpl) return { skipped: 'no fetch implementation' };
    },
    async decide(c: DecisionCase): Promise<ProviderAnswer> {
      const systemOneRequest = buildRequest(c, model);
      const validChoices = Object.keys(systemOneRequest.questions.q.criteria);
      const request = protocol === 'openai-chat' ? buildOpenAIChatRequest(c, model) : systemOneRequest;
      let attempt = 0;
      for (;;) {
        if (!fetchImpl || !apiKey) return abstain({ reason: 'provider not initialized' });
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          signal: AbortSignal.timeout(30_000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(request),
        });
        if (res.status === 429 || res.status === 529) {
          attempt += 1;
          if (attempt > MAX_RETRIES) return abstain({ reason: `gave up after ${MAX_RETRIES} retries`, status: res.status });
          const retryAfter = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BASE_BACKOFF_MS * 2 ** (attempt - 1);
          await sleep(Math.min(wait, 30_000));
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return abstain({ reason: `http ${res.status}`, body: text.slice(0, 500) });
        }
        const body: unknown = await res.json();
        return protocol === 'openai-chat' ? parseOpenAIChatResponse(body, validChoices) : parseResponse(body, validChoices);
      }
    },
  };
}
