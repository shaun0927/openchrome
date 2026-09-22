import * as fs from 'fs/promises';
import * as path from 'path';
import type { LearningEvent } from './types.js';
import { choicesForLearningTask } from './types.js';
import { randomUUID } from 'crypto';
import { redactLearningState } from './redaction.js';
import { isLearningEvent } from './validation.js';

export interface LearningEventStore {
  append(event: LearningEvent): Promise<void>;
}

export class MemoryLearningEventStore implements LearningEventStore {
  readonly events: LearningEvent[] = [];

  async append(event: LearningEvent): Promise<void> {
    this.events.push(sanitizeEvent(event));
  }
}

export class JsonlLearningEventStore implements LearningEventStore {
  constructor(private readonly file: string) {}

  async append(event: LearningEvent): Promise<void> {
    const safe = sanitizeEvent(event);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.appendFile(this.file, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

function sanitizeEvent(event: LearningEvent): LearningEvent {
  if (!event.privacy.redacted) throw new Error('unredacted events cannot be stored');
  const choices = choicesForLearningTask(event.task);
  if (!choices.includes(event.deterministic_answer) || !choices.includes(event.final_answer)) throw new Error('invalid task answer');
  if (event.label && (!choices.includes(event.label.answer) || !['host', 'user', 'test', 'heuristic'].includes(event.label.source))) throw new Error('invalid task label');
  const redacted = redactLearningState(event.state);
  const now = new Date().toISOString();
  const review = event.model_review;
  return { id: randomUUID(), task: event.task, question_id: event.task, created_at: now,
    choices, deterministic_answer: event.deterministic_answer, final_answer: event.final_answer,
    state: redacted.state,
    model_review: review && choices.includes(review.answer) && Number.isFinite(review.confidence) ? {
      provider: 'bounded-reviewer', answer: review.answer, confidence: Math.max(0, Math.min(1, review.confidence)),
      abstain: review.abstain === true, disagreement: review.answer !== event.deterministic_answer,
    } : null,
    label: event.label ? { answer: event.label.answer, source: event.label.source, created_at: now } : null,
    privacy: { redacted: true, contains_sensitive: false } };
}

export async function readLearningEventsFromJsonl(file: string): Promise<LearningEvent[]> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  const events: LearningEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    if (!isLearningEvent(parsed)) throw new Error('invalid learning event schema');
    events.push(parsed);
  }
  return events;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
