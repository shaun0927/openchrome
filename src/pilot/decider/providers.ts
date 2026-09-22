import type { DecisionAnswer, DecisionProvider, DecisionQuestion } from './types.js';
import { clampConfidence, NONE_CHOICE } from './types.js';

export interface HostDecisionDelegate {
  (question: DecisionQuestion): Promise<Omit<DecisionAnswer, 'provider'> | DecisionAnswer>;
}

export function createNoopDecisionProvider(name = 'noop'): DecisionProvider {
  return {
    name,
    async decide(): Promise<DecisionAnswer> {
      return { provider: name, answer: NONE_CHOICE, confidence: 0, abstain: true, reason: 'noop' };
    },
  };
}

export function createHostDecisionProvider(delegate: HostDecisionDelegate, name = 'host'): DecisionProvider {
  return {
    name,
    async decide(question: DecisionQuestion): Promise<DecisionAnswer> {
      const answer = await delegate(question);
      return normalizeAnswer(name, answer);
    },
  };
}

export interface TypeSafeDecisionProviderOptions {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly protocol?: 'systemone' | 'openai-chat';
  readonly fetchImpl?: typeof fetch;
}

export const TYPESAFE_DECIDER_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_DECIDER_MODEL = 'jev-latest';
export const VERCEL_AI_GATEWAY_DECIDER_ENDPOINT = 'https://ai-gateway.vercel.sh/v1/chat/completions';
export const VERCEL_JEV_DECIDER_MODEL = 'typesafe-ai/jev';

interface TypeSafeQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Record<string, string | null>;
}

export interface TypeSafeDecisionRequest {
  readonly model: string;
  readonly state: unknown;
  readonly questions: { readonly q: TypeSafeQuestion };
}

export interface OpenAIChatDecisionRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<{ readonly role: 'system' | 'user'; readonly content: string }>;
  readonly temperature: number;
}

export function buildTypeSafeDecisionRequest(question: DecisionQuestion, model = TYPESAFE_DECIDER_MODEL): TypeSafeDecisionRequest {
  const criteria: Record<string, string | null> = {};
  for (const choice of question.choices) criteria[choice.id] = choice.label;
  criteria.none_of_the_above = null;
  return {
    model,
    state: question.state,
    questions: {
      q: {
        type: 'choice',
        instructions: question.instructions,
        criteria,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTypeSafeDecisionResponse(provider: string, body: unknown): DecisionAnswer {
  if (!isRecord(body)) return abstain(provider, 'non_object_response', body);
  const container = [body.answers, body.results, body.questions, body]
    .find((candidate): candidate is Record<string, unknown> => isRecord(candidate) && 'q' in candidate);
  const q = container?.q;
  if (q === undefined) return abstain(provider, 'missing_q', body);

  let choice: string | undefined;
  let confidence: number | undefined;
  if (typeof q === 'string') {
    choice = q;
  } else if (isRecord(q)) {
    for (const key of ['choice', 'answer', 'value', 'selected']) {
      if (typeof q[key] === 'string') {
        choice = q[key] as string;
        break;
      }
    }
    for (const key of ['confidence', 'probability', 'score']) {
      if (typeof q[key] === 'number') {
        confidence = q[key] as number;
        break;
      }
    }
    if (choice === undefined) {
      let best: { id: string; probability: number } | undefined;
      for (const [id, probability] of Object.entries(q)) {
        if (typeof probability === 'number' && (!best || probability > best.probability)) {
          best = { id, probability };
        }
      }
      if (best) {
        choice = best.id;
        confidence = confidence ?? best.probability;
      }
    }
  }

  if (choice === undefined) return abstain(provider, 'missing_choice', body);
  if (choice === 'none_of_the_above' || choice === NONE_CHOICE) {
    return { provider, answer: NONE_CHOICE, confidence: clampConfidence(confidence ?? 0.5), abstain: true, raw: body };
  }
  return { provider, answer: choice, confidence: clampConfidence(confidence ?? 0.5), abstain: false, raw: body };
}

function protocolFromEndpoint(endpoint: string): 'systemone' | 'openai-chat' {
  return endpoint.includes('/chat/completions') ? 'openai-chat' : 'systemone';
}

function buildChoicePrompt(question: DecisionQuestion, model: string): string {
  return [
    buildTypeSafeDecisionRequest(question, model).questions.q.instructions,
    '',
    'Choose exactly one criterion id. Return JSON only in this shape:',
    '{"q":{"choice":"<criterion_id>","confidence":0.0}}',
    '',
    `Criteria: ${JSON.stringify(Object.fromEntries(question.choices.map((choice) => [choice.id, choice.label])))}`,
    `State: ${JSON.stringify(question.state)}`,
  ].join('\n');
}

export function buildOpenAIChatDecisionRequest(question: DecisionQuestion, model = VERCEL_JEV_DECIDER_MODEL): OpenAIChatDecisionRequest {
  return {
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: 'You are a fast structured decision model for browser automation. Return only machine-readable JSON.',
      },
      { role: 'user', content: buildChoicePrompt(question, model) },
    ],
  };
}

function parseOpenAIContent(provider: string, content: string): DecisionAnswer {
  const trimmed = content.trim();
  try {
    return parseTypeSafeDecisionResponse(provider, JSON.parse(trimmed));
  } catch {
    const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (stripped !== trimmed) {
      try {
        return parseTypeSafeDecisionResponse(provider, JSON.parse(stripped));
      } catch {
      }
    }
  }
  const normalized = trimmed.replace(/^["']|["']$/g, '');
  if (normalized === 'none_of_the_above' || normalized === NONE_CHOICE) {
    return { provider, answer: NONE_CHOICE, confidence: 0.5, abstain: true, raw: { content } };
  }
  if (normalized.length > 0 && /^[A-Za-z0-9_.:-]+$/.test(normalized)) {
    return { provider, answer: normalized, confidence: 0.5, abstain: false, raw: { content } };
  }
  return abstain(provider, 'chat_content_missing_choice', { content });
}

export function parseOpenAIChatDecisionResponse(provider: string, body: unknown): DecisionAnswer {
  if (!isRecord(body) || !Array.isArray(body.choices)) return abstain(provider, 'non_chat_response', body);
  const first = body.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== 'string') {
    return abstain(provider, 'missing_chat_content', body);
  }
  const parsed = parseOpenAIContent(provider, first.message.content);
  return { ...parsed, raw: parsed.raw ?? body };
}

export function createTypeSafeDecisionProvider(opts: TypeSafeDecisionProviderOptions = {}): DecisionProvider {
  const name = 'typesafe';
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.AI_GATEWAY_API_KEY;
  const endpoint = opts.endpoint ?? process.env.TYPESAFE_ENDPOINT ?? TYPESAFE_DECIDER_ENDPOINT;
  const protocol = opts.protocol ?? (process.env.TYPESAFE_PROTOCOL as 'systemone' | 'openai-chat' | undefined) ?? protocolFromEndpoint(endpoint);
  const model = opts.model ?? process.env.TYPESAFE_MODEL ?? (protocol === 'openai-chat' ? VERCEL_JEV_DECIDER_MODEL : TYPESAFE_DECIDER_MODEL);
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  return {
    name,
    async decide(question: DecisionQuestion): Promise<DecisionAnswer> {
      if (!apiKey) return { provider: name, answer: NONE_CHOICE, confidence: 0, abstain: true, downgraded: true, reason: 'no_key' };
      if (!fetchImpl) return { provider: name, answer: NONE_CHOICE, confidence: 0, abstain: true, downgraded: true, reason: 'no_fetch' };
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(protocol === 'openai-chat' ? buildOpenAIChatDecisionRequest(question, model) : buildTypeSafeDecisionRequest(question, model)),
      });
      if (!response.ok) return { provider: name, answer: NONE_CHOICE, confidence: 0, abstain: true, downgraded: true, reason: `http_${response.status}` };
      return protocol === 'openai-chat' ? parseOpenAIChatDecisionResponse(name, await response.json()) : parseTypeSafeDecisionResponse(name, await response.json());
    },
  };
}

function normalizeAnswer(provider: string, answer: Omit<DecisionAnswer, 'provider'> | DecisionAnswer): DecisionAnswer {
  const providerName = 'provider' in answer ? answer.provider : provider;
  const isNone = answer.answer === NONE_CHOICE || answer.answer.length === 0;
  return {
    ...answer,
    provider: providerName,
    answer: isNone ? NONE_CHOICE : answer.answer,
    confidence: clampConfidence(answer.confidence),
    abstain: answer.abstain || isNone,
  };
}

function abstain(provider: string, reason: string, raw: unknown): DecisionAnswer {
  return { provider, answer: NONE_CHOICE, confidence: 0, abstain: true, reason, raw };
}
