import * as fs from 'fs/promises';
import * as path from 'path';
import type { LearningEvent } from './types.js';
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
  const redacted = redactLearningState(event.state);
  const { actual_result: _actual, ...safe } = event;
  return { ...safe, question_id: event.task, state: redacted.state,
    privacy: { redacted: true, contains_sensitive: event.privacy.contains_sensitive || redacted.containsSensitive } };
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
