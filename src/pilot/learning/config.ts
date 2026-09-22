import * as os from 'os';
import * as path from 'path';
import type { LearningTask } from './types.js';
import { LEARNING_TASKS } from './types.js';

export type LearningMode = 'disabled' | 'local_only';

export interface LearningSettings {
  readonly enabled: boolean;
  readonly mode: LearningMode;
  readonly baseDir: string;
  readonly storePath: string;
  readonly registryPath: string;
  readonly tasks: readonly LearningTask[];
}

export interface LearningConfigInput {
  readonly enabled?: boolean;
  readonly mode?: LearningMode;
  readonly baseDir?: string;
  readonly storePath?: string;
  readonly registryPath?: string;
  readonly tasks?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

const DEFAULT_TASKS: readonly LearningTask[] = ['irreversible_policy', 'outcome_failure_triage'];

export function defaultLearningBaseDir(): string {
  return path.join(os.homedir(), '.openchrome', 'learning');
}

export function resolveLearningSettings(input: LearningConfigInput = {}): LearningSettings {
  const env = input.env ?? process.env;
  const envEnabled = parseEnabled(env.OPENCHROME_LEARNING);
  const enabled = input.enabled ?? envEnabled ?? false;
  const mode = input.mode ?? (env.OPENCHROME_LEARNING_MODE === undefined ? (enabled ? 'local_only' : 'disabled') : parseMode(env.OPENCHROME_LEARNING_MODE) ?? 'disabled');
  const baseDir = input.baseDir ?? env.OPENCHROME_LEARNING_DIR ?? defaultLearningBaseDir();
  const storePath = input.storePath ?? env.OPENCHROME_LEARNING_STORE ?? path.join(baseDir, 'events.jsonl');
  const registryPath = input.registryPath ?? env.OPENCHROME_LEARNING_REGISTRY ?? path.join(baseDir, 'adapter-registry.json');
  const tasks = parseTasks(input.tasks ?? splitCsv(env.OPENCHROME_LEARNING_TASKS));
  return {
    enabled: enabled && mode === 'local_only',
    mode: enabled && mode === 'local_only' ? 'local_only' : 'disabled',
    baseDir,
    storePath,
    registryPath,
    tasks,
  };
}

export function taskEnabled(settings: LearningSettings, task: LearningTask): boolean {
  return settings.enabled && settings.tasks.includes(task);
}

function parseEnabled(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'local_only'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return undefined;
}

function parseMode(value: string | undefined): LearningMode | undefined {
  if (value === 'local_only' || value === 'disabled') return value;
  return undefined;
}

function splitCsv(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseTasks(values: readonly string[] | undefined): readonly LearningTask[] {
  if (values === undefined) return DEFAULT_TASKS;
  const allowed = new Set<string>(LEARNING_TASKS);
  const tasks = values.filter((value): value is LearningTask => allowed.has(value));
  return tasks;
}
