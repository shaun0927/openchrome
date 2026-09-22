import * as crypto from 'crypto';
import type { DatasetSplit, LearningDataset, LearningDatasetExample, LearningEvent, LearningLabelSource, LearningTask } from './types.js';
import { canonicalState, hasSafeState, hasTaskChoices } from './validation.js';
import { choicesForLearningTask } from './types.js';

export interface BuildLearningDatasetInput {
  readonly events: readonly LearningEvent[];
  readonly task: LearningTask;
  readonly labelSources?: readonly LearningLabelSource[];
}

export interface SplitLearningDatasetInput {
  readonly examples: readonly LearningDatasetExample[];
  readonly holdoutRatio: number;
}

export function buildLearningDataset(input: BuildLearningDatasetInput): LearningDataset {
  const examples: LearningDatasetExample[] = [];
  const classCounts: Record<string, number> = {};
  let skippedUnlabeled = 0;
  let skippedSensitive = 0;
  let skippedTask = 0;
  let skippedLabelSource = 0;
  let skippedInvalidChoice = 0;
  const allowedLabelSources = new Set(input.labelSources ?? ['host', 'user']);
  for (const event of input.events) {
    if (event.task !== input.task) {
      skippedTask += 1;
      continue;
    }
    if (!event.label) {
      skippedUnlabeled += 1;
      continue;
    }
    if (!event.privacy.redacted || event.privacy.contains_sensitive || !hasSafeState(event.state)) {
      skippedSensitive += 1;
      continue;
    }
    if (allowedLabelSources && !allowedLabelSources.has(event.label.source)) {
      skippedLabelSource += 1;
      continue;
    }
    if (!hasTaskChoices(event)) {
      skippedInvalidChoice += 1;
      continue;
    }
    classCounts[event.label.answer] = (classCounts[event.label.answer] ?? 0) + 1;
    examples.push({
      id: crypto.createHash('sha256').update(event.id).digest('hex'),
      task: event.task,
      state: event.state,
      choices: choicesForLearningTask(event.task),
      label: event.label.answer,
      label_source: event.label.source,
      deterministic_answer: event.deterministic_answer,
      model_answer: null,
    });
  }
  return {
    examples,
    report: {
      task: input.task,
      total_events: input.events.length,
      labeled_examples: examples.length,
      skipped_unlabeled: skippedUnlabeled,
      skipped_sensitive: skippedSensitive,
      skipped_task: skippedTask,
      skipped_label_source: skippedLabelSource,
      skipped_invalid_choice: skippedInvalidChoice,
      class_counts: classCounts,
    },
  };
}

export function splitLearningDataset(input: SplitLearningDatasetInput): DatasetSplit {
  if (!Number.isFinite(input.holdoutRatio) || input.holdoutRatio <= 0 || input.holdoutRatio >= 1) throw new RangeError('holdout ratio must be between 0 and 1');
  const holdoutRatio = input.holdoutRatio;
  const train: LearningDatasetExample[] = [];
  const holdout: LearningDatasetExample[] = [];
  for (const example of input.examples) {
    if (hashBucket(canonicalState([example.task, example.state, choicesForLearningTask(example.task)])) < holdoutRatio) holdout.push(example);
    else train.push(example);
  }
  return { train, holdout };
}

function hashBucket(value: string): number {
  const hash = crypto.createHash('sha256').update(value).digest();
  return hash.readUInt32BE(0) / 0xffffffff;
}
