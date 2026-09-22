/**
 * `file` provider — replays pre-recorded answers from a JSON file.
 *
 * Stand-in for a host-sampling decider in CI: a human or an LLM session
 * answers the corpus once, writes the file, and the evaluator scores it
 * offline. Accepted shapes:
 *
 *   {"<case id>": {"answer": "ref_3", "confidence": 0.8}, ...}
 *   {"answers": {"<case id>": {...}}}
 *   {"answers": [{"id": "<case id>", "answer": "...", "confidence": 0.8}]}
 *
 * Cases with no entry are abstained (answer "none", confidence 0).
 */

import * as fs from 'fs';
import type { DecisionCase } from '../../../tests/fixtures/decisions/schema';
import type { DecisionProvider, ProviderAnswer, ProviderInit } from './types';
import { abstain, clamp01, NONE } from './types';

interface RecordedAnswer {
  answer: string;
  confidence?: number;
}

export function parseAnswersFile(text: string): Map<string, RecordedAnswer> {
  const parsed: unknown = JSON.parse(text);
  const map = new Map<string, RecordedAnswer>();
  const container = (typeof parsed === 'object' && parsed !== null && 'answers' in parsed)
    ? (parsed as { answers: unknown }).answers
    : parsed;
  if (Array.isArray(container)) {
    for (const entry of container) {
      if (typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string') {
        const e = entry as { id: string; answer?: unknown; confidence?: unknown };
        map.set(e.id, { answer: String(e.answer ?? NONE), confidence: typeof e.confidence === 'number' ? e.confidence : undefined });
      }
    }
    return map;
  }
  if (typeof container === 'object' && container !== null) {
    for (const [id, value] of Object.entries(container as Record<string, unknown>)) {
      if (typeof value === 'string') map.set(id, { answer: value });
      else if (typeof value === 'object' && value !== null) {
        const v = value as { answer?: unknown; confidence?: unknown };
        map.set(id, { answer: String(v.answer ?? NONE), confidence: typeof v.confidence === 'number' ? v.confidence : undefined });
      }
    }
    return map;
  }
  throw new Error('answers file must be an object map or an array of {id, answer, confidence}');
}

export function createFileProvider(answersFile: string | undefined): DecisionProvider {
  let answers = new Map<string, RecordedAnswer>();
  return {
    name: 'file',
    async init(): Promise<ProviderInit | void> {
      if (!answersFile) return { skipped: 'no answers file (--answers <path>)' };
      if (!fs.existsSync(answersFile)) return { skipped: `answers file not found: ${answersFile}` };
      answers = parseAnswersFile(fs.readFileSync(answersFile, 'utf8'));
    },
    async decide(c: DecisionCase): Promise<ProviderAnswer> {
      const rec = answers.get(c.id);
      if (!rec) return abstain({ reason: 'no recorded answer' });
      const answer = rec.answer;
      const isNone = answer === NONE || answer.length === 0;
      return { answer: isNone ? NONE : answer, confidence: clamp01(rec.confidence ?? (isNone ? 0 : 1)), abstain: isNone };
    },
  };
}
