import * as fs from 'fs';
import * as path from 'path';

import type { FailureCategory, RealWorldTaskRun } from './types';
import { realWorldTaskSpecs } from './fixtures';

export interface RecordedRealWorldSample {
  library: string;
  mode: 'recorded-real' | 'live-llm';
  taskId: string;
  success: boolean;
  firstAttempt: boolean;
  recovered: boolean | null;
  wallTimeMs: number;
  toolCalls: number;
  retries: number;
  noProgressLoops: number;
  tokens: number | null;
  usd: number | null;
  failureCategory: FailureCategory;
  finalPostconditionEvidence: string;
  competitorVersion: string;
  llmModel: string;
  notes?: string;
}

const TASK_IDS = new Set(realWorldTaskSpecs.map((task) => task.id));

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function assertNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function assertNullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null) return null;
  return assertBoolean(value, label);
}

function assertNullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  return assertNumber(value, label);
}

export function parseRecordedSample(raw: unknown, source = '<memory>'): RecordedRealWorldSample {
  if (!raw || typeof raw !== 'object') throw new Error(`${source}: sample must be an object`);
  const obj = raw as Record<string, unknown>;
  const taskId = assertString(obj.taskId, `${source}: taskId`);
  if (!TASK_IDS.has(taskId)) throw new Error(`${source}: unknown taskId ${taskId}`);
  const mode = obj.mode === 'recorded-real' || obj.mode === 'live-llm' ? obj.mode : undefined;
  if (!mode) throw new Error(`${source}: mode must be recorded-real or live-llm`);
  const evidence = assertString(obj.finalPostconditionEvidence, `${source}: finalPostconditionEvidence`);
  return {
    library: assertString(obj.library, `${source}: library`),
    mode,
    taskId,
    success: assertBoolean(obj.success, `${source}: success`),
    firstAttempt: assertBoolean(obj.firstAttempt, `${source}: firstAttempt`),
    recovered: assertNullableBoolean(obj.recovered, `${source}: recovered`),
    wallTimeMs: assertNumber(obj.wallTimeMs, `${source}: wallTimeMs`),
    toolCalls: assertNumber(obj.toolCalls, `${source}: toolCalls`),
    retries: assertNumber(obj.retries, `${source}: retries`),
    noProgressLoops: assertNumber(obj.noProgressLoops, `${source}: noProgressLoops`),
    tokens: assertNullableNumber(obj.tokens, `${source}: tokens`),
    usd: assertNullableNumber(obj.usd, `${source}: usd`),
    failureCategory: assertString(obj.failureCategory, `${source}: failureCategory`) as FailureCategory,
    finalPostconditionEvidence: evidence,
    competitorVersion: assertString(obj.competitorVersion, `${source}: competitorVersion`),
    llmModel: assertString(obj.llmModel, `${source}: llmModel`),
    notes: typeof obj.notes === 'string' ? obj.notes : '',
  };
}

export function loadRecordedSamples(recordingDir: string): RecordedRealWorldSample[] {
  const files = fs.readdirSync(recordingDir).filter((file) => file.endsWith('.json')).sort();
  const samples: RecordedRealWorldSample[] = [];
  for (const file of files) {
    const full = path.join(recordingDir, file);
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (let i = 0; i < entries.length; i++) samples.push(parseRecordedSample(entries[i], `${file}[${i}]`));
  }
  return samples;
}

export function recordedSamplesToRuns(samples: readonly RecordedRealWorldSample[]): RealWorldTaskRun[] {
  return samples.map((sample) => ({
    library: sample.library,
    taskId: sample.taskId,
    mode: sample.mode,
    success: sample.success,
    firstAttempt: sample.firstAttempt,
    recovered: sample.recovered,
    wallTimeMs: sample.wallTimeMs,
    toolCalls: sample.toolCalls,
    retries: sample.retries,
    noProgressLoops: sample.noProgressLoops,
    tokens: sample.tokens,
    usd: sample.usd,
    failureCategory: sample.failureCategory,
    finalPostconditionEvidence: sample.finalPostconditionEvidence,
    finalPostconditionEvaluated: true,
    notes: `recorded final-postcondition evidence: ${sample.finalPostconditionEvidence}${sample.notes ? `; ${sample.notes}` : ''}`,
  }));
}

export function competitorPinsFromRecordings(samples: readonly RecordedRealWorldSample[]): Array<{ name: string; version: string; measuredAt?: string }> {
  const byLibrary = new Map<string, string>();
  for (const sample of samples) {
    const existing = byLibrary.get(sample.library);
    if (existing && existing !== sample.competitorVersion) throw new Error(`multiple versions recorded for ${sample.library}: ${existing}, ${sample.competitorVersion}`);
    byLibrary.set(sample.library, sample.competitorVersion);
  }
  return Array.from(byLibrary.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => ({ name, version }));
}
