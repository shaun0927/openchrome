import * as fs from 'fs/promises';
import * as path from 'path';
import { buildLearningDataset, splitLearningDataset } from './dataset.js';
import { isLearningEvent } from './validation.js';
import type { LearningEvent } from './types.js';
import type { LearningDatasetReport, LearningLabelSource, LearningTask } from './types.js';

export interface ExportLearningDatasetInput {
  readonly inputPath: string;
  readonly outDir: string;
  readonly task: LearningTask;
  readonly labelSources?: readonly LearningLabelSource[];
  readonly holdoutRatio: number;
}

export interface ExportLearningDatasetResult {
  readonly trainPath: string;
  readonly holdoutPath: string;
  readonly reportPath: string;
  readonly report: LearningDatasetReport;
}

export async function exportLearningDataset(input: ExportLearningDatasetInput): Promise<ExportLearningDatasetResult> {
  const { events, invalid } = await readExportEvents(input.inputPath);
  const dataset = buildLearningDataset({ events, task: input.task, labelSources: input.labelSources });
  const split = splitLearningDataset({ examples: dataset.examples, holdoutRatio: input.holdoutRatio });
  const report = { ...dataset.report, total_events: dataset.report.total_events + invalid, skipped_invalid_record: invalid,
    privacy_validation: 'allowlisted_state_only', train_count: split.train.length, holdout_count: split.holdout.length };
  await fs.mkdir(input.outDir, { recursive: true });
  const trainPath = path.join(input.outDir, `${input.task}.train.jsonl`);
  const holdoutPath = path.join(input.outDir, `${input.task}.holdout.jsonl`);
  const reportPath = path.join(input.outDir, `${input.task}.report.json`);
  await fs.writeFile(trainPath, toJsonl(split.train), 'utf8');
  await fs.writeFile(holdoutPath, toJsonl(split.holdout), 'utf8');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { trainPath, holdoutPath, reportPath, report };
}

export async function validateLearningEvents(inputPath: string, task: LearningTask): Promise<LearningDatasetReport> {
  const { events, invalid } = await readExportEvents(inputPath);
  const report = buildLearningDataset({ events, task }).report;
  return { ...report, total_events: report.total_events + invalid, skipped_invalid_record: invalid };
}

async function readExportEvents(file: string): Promise<{ events: LearningEvent[]; invalid: number }> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { events: [], invalid: 0 };
    throw error;
  }
  const events: LearningEvent[] = [];
  let invalid = 0;
  for (const line of text.split(/\r?\n/).filter((value) => value.trim())) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isLearningEvent(parsed)) events.push(parsed);
      else invalid++;
    } catch (error) { if (error instanceof SyntaxError) invalid++; else throw error; }
  }
  return { events, invalid };
}

function toJsonl(values: readonly unknown[]): string {
  if (values.length === 0) return '';
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}
