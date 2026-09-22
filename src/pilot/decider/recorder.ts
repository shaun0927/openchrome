import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { DecisionAnswer, DecisionQuestion, DecisionRecord, DecisionRecorder } from './types.js';

export class MemoryDecisionRecorder implements DecisionRecorder {
  readonly records: DecisionRecord[] = [];

  async record(question: DecisionQuestion, answer: DecisionAnswer, actualResult?: unknown): Promise<DecisionRecord> {
    const record = toRecord(question, answer, actualResult);
    this.records.push(record);
    return record;
  }
}

export class JsonlDecisionRecorder implements DecisionRecorder {
  constructor(private readonly file: string) {}

  async record(question: DecisionQuestion, answer: DecisionAnswer, actualResult?: unknown): Promise<DecisionRecord> {
    const record = toRecord(question, answer, actualResult);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }
}

function toRecord(question: DecisionQuestion, answer: DecisionAnswer, actualResult?: unknown): DecisionRecord {
  return {
    id: crypto.randomUUID(),
    provider: answer.provider,
    question_id: question.id,
    answer: answer.answer,
    confidence: answer.confidence,
    abstain: answer.abstain,
    downgraded: answer.downgraded === true,
    ...(answer.reason ? { reason: answer.reason } : {}),
    created_at: new Date().toISOString(),
    ...(actualResult !== undefined ? { actual_result: actualResult } : {}),
  };
}
