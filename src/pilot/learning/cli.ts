import * as fs from 'fs/promises';
import * as path from 'path';
import type { Command } from 'commander';
import { resolveLearningSettings } from './config.js';
import { exportLearningDataset, validateLearningEvents } from './export.js';
import { readAdapterRegistry, promoteAdapter } from './registry-store.js';
import type { LearningLabelSource, LearningTask } from './types.js';
import { LEARNING_TASKS } from './types.js';
import { evaluateLearningPredictions } from './evaluation.js';

interface LearningCommandOptions {
  readonly store?: string;
  readonly registry?: string;
  readonly outDir?: string;
  readonly task?: string;
  readonly labelSources?: string;
  readonly holdout?: string;
  readonly adapter?: string;
  readonly status?: string;
  readonly evalReport?: string;
  readonly dataset?: string;
  readonly json?: boolean;
  readonly predictions?: string;
  readonly artifactSha256?: string;
}

export function registerLearningCommand(program: Command): void {
  program
    .command('learning')
    .description('Manage opt-in local learning events and bounded Laya adapter scaffolding')
    .argument('<action>', 'status|export|validate|eval|finetune|registry-list|registry-promote')
    .option('--store <path>', 'Learning JSONL event store path')
    .option('--registry <path>', 'Adapter registry JSON path')
    .option('--out-dir <path>', 'Output directory')
    .option('--task <task>', 'Learning task')
    .option('--label-sources <csv>', 'Allowed label sources for export')
    .option('--holdout <ratio>', 'Holdout ratio for export', '0.2')
    .option('--dataset <path>', 'Dataset JSONL path for eval/finetune')
    .option('--predictions <path>', 'Offline prediction manifest for evaluation')
    .option('--artifact-sha256 <hash>', 'Adapter artifact SHA256')
    .option('--adapter <id>', 'Adapter id for registry promotion')
    .option('--status <status>', 'Target adapter status')
    .option('--eval-report <path>', 'Eval report path required for assist promotion')
    .option('--json', 'Print JSON output')
    .action(async (action: string, options: LearningCommandOptions) => {
      try {
        const result = await runLearningAction(action, options);
        printResult(result, options.json === true);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });
}

export async function runLearningAction(action: string, options: LearningCommandOptions): Promise<unknown> {
  const settings = resolveLearningSettings({
    enabled: process.env.OPENCHROME_LEARNING !== undefined ? undefined : false,
    storePath: options.store,
    registryPath: options.registry,
  });
  const task = parseTask(options.task);
  switch (action) {
    case 'status':
      return { settings };
    case 'export':
      return exportLearningDataset({
        inputPath: options.store ?? settings.storePath,
        outDir: options.outDir ?? path.join(settings.baseDir, 'datasets'),
        task,
        labelSources: parseLabelSources(options.labelSources),
        holdoutRatio: parseRatio(options.holdout),
      });
    case 'validate':
      return validateLearningEvents(options.store ?? settings.storePath, task);
    case 'eval':
      {
        const report = await evaluateLearningPredictions({ datasetPath: requireString(options.dataset, '--dataset required'),
          predictionsPath: requireString(options.predictions, '--predictions required'), adapterId: requireString(options.adapter, '--adapter required'),
          artifactSha256: requireString(options.artifactSha256, '--artifact-sha256 required') });
        const outDir = options.outDir ?? settings.baseDir;
        await fs.mkdir(outDir, { recursive: true });
        await fs.writeFile(path.join(outDir, 'eval-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        return report;
      }
    case 'finetune':
      return writeFinetuneScaffold(options.outDir ?? settings.baseDir, task, options.dataset);
    case 'registry-list':
      return readAdapterRegistry(options.registry ?? settings.registryPath);
    case 'registry-promote':
      return promoteAdapter({
        registryPath: options.registry ?? settings.registryPath,
        adapterId: requireString(options.adapter, '--adapter is required'),
        status: parsePromotionStatus(options.status),
        evalReportPath: requireString(options.evalReport, '--eval-report is required'),
        datasetPath: options.dataset,
        predictionsPath: options.predictions,
      });
    default:
      throw new Error(`unknown learning action: ${action}`);
  }
}

function printResult(result: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

function parseTask(value: string | undefined): LearningTask {
  if (value && (LEARNING_TASKS as readonly string[]).includes(value)) return value as LearningTask;
  if (value) throw new Error('unknown learning task');
  return 'irreversible_policy';
}

function parseLabelSources(value: string | undefined): readonly LearningLabelSource[] | undefined {
  if (!value) return undefined;
  const allowed = new Set(['host', 'user', 'test', 'heuristic']);
  if (value.split(',').some((item) => !allowed.has(item.trim()))) throw new Error('unknown label source');
  return value.split(',')
    .map((item) => item.trim())
    .filter((item): item is LearningLabelSource => allowed.has(item));
}

function parseRatio(value: string | undefined): number {
  const ratio = Number(value ?? 0.2);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) throw new Error('holdout must be between 0 and 1');
  return ratio;
}

function parsePromotionStatus(value: string | undefined): 'shadow' | 'assist' | 'disabled' {
  if (value === 'shadow' || value === 'assist' || value === 'disabled') return value;
  throw new Error('--status must be shadow, assist, or disabled');
}

function requireString(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

async function writeFinetuneScaffold(outDir: string, task: LearningTask, datasetPath: string | undefined): Promise<unknown> {
  await fs.mkdir(outDir, { recursive: true });
  const report = {
    task,
    dataset: datasetPath ?? null,
    status: 'blocked_scaffold',
    reason: 'No automatic background fine-tuning is implemented. Provide a local Laya fine-tuning runtime and run this scaffold explicitly.',
  };
  const outPath = path.join(outDir, `${task}.finetune-scaffold.json`);
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { output: outPath, ...report };
}
