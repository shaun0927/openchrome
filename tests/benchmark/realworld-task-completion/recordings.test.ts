/// <reference types="jest" />

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildRealWorldTaskCompletionResult } from '../run-realworld-task-completion';
import { loadRecordedSamples, recordedSamplesToRuns } from './recordings';

function sample(library: string, i: number) {
  return {
    library,
    mode: 'recorded-real',
    taskId: 'rw-001-checkout-update-address',
    success: true,
    firstAttempt: true,
    recovered: null,
    wallTimeMs: 1000 + i,
    toolCalls: 6,
    retries: 0,
    noProgressLoops: 0,
    tokens: 100 + i,
    usd: 0.001,
    failureCategory: 'none',
    finalPostconditionEvidence: `postcondition ok ${i}`,
    competitorVersion: library === 'openchrome' ? '1.12.2' : 'fixture-1.0.0',
    llmModel: 'claude-sonnet-fixed',
  };
}

describe('real-world recorded evidence ingestion', () => {
  test('loads recorded samples and converts them to task runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-recordings-'));
    fs.writeFileSync(path.join(dir, 'samples.json'), JSON.stringify([sample('openchrome', 0), sample('playwright', 1)]));
    const samples = loadRecordedSamples(dir);
    const runs = recordedSamplesToRuns(samples);
    expect(samples).toHaveLength(2);
    expect(runs.map((run) => run.mode)).toEqual(['recorded-real', 'recorded-real']);
    expect(runs[0].notes).toMatch(/final-postcondition evidence/);
  });

  test('builds a headline-eligible aggregate when recorded evidence meets gates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-recordings-'));
    const rows = Array.from({ length: 10 }, (_, i) => sample(i % 2 === 0 ? 'openchrome' : 'playwright', i));
    fs.writeFileSync(path.join(dir, 'samples.json'), JSON.stringify(rows));
    const envelope = buildRealWorldTaskCompletionResult([`--recording-dir=${dir}`]);
    const result = envelope.results[0];
    expect(result.measurementMode).toBe('recorded-real');
    expect(result.claimEligibility.eligible).toBe(true);
    expect(result.metrics.map((row: { library: string }) => row.library).sort()).toEqual(['openchrome', 'playwright']);
  });
});
