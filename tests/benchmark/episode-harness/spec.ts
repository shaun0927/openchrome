import type { Assertion } from '../../../src/contracts/types';
import type { EpisodeTaskCategory, EpisodeTaskSpec, NormalizedEpisodeTaskSpec } from './types';

const DEFAULT_MAX_STEPS = 30;
const DEFAULT_MAX_DURATION_MS = 120_000;
const MAX_STEPS = 100;
const MAX_DURATION_MS = 600_000;

const TASK_KEYS = new Set(['id', 'title', 'startUrl', 'goal', 'maxSteps', 'maxDurationMs', 'success', 'setup', 'tags', 'category', 'expectedFirstTool']);
const SETUP_KEYS = new Set(['clearCookies', 'viewport']);
const VIEWPORT_KEYS = new Set(['width', 'height']);
const TASK_CATEGORIES = new Set<EpisodeTaskCategory>([
  'info_retrieval',
  'multi_step_navigation',
  'form_fill',
  'transactional_mock',
  'recovery',
  'dynamic_ui',
  'long_horizon',
]);

export function normalizeTaskSpec(input: unknown): NormalizedEpisodeTaskSpec {
  if (!isRecord(input)) throw new Error('Episode task must be an object');
  rejectUnknownKeys(input, TASK_KEYS, 'task');

  const maxSteps = numberWithDefault(input.maxSteps, DEFAULT_MAX_STEPS, 'maxSteps');
  const maxDurationMs = numberWithDefault(input.maxDurationMs, DEFAULT_MAX_DURATION_MS, 'maxDurationMs');
  if (maxSteps > MAX_STEPS) throw new Error(`maxSteps must be <= ${MAX_STEPS}`);
  if (maxDurationMs > MAX_DURATION_MS) throw new Error(`maxDurationMs must be <= ${MAX_DURATION_MS}`);

  const task: NormalizedEpisodeTaskSpec = {
    id: requiredString(input.id, 'id'),
    title: requiredString(input.title, 'title'),
    startUrl: requiredString(input.startUrl, 'startUrl'),
    goal: requiredString(input.goal, 'goal'),
    maxSteps,
    maxDurationMs,
    success: validateAssertion(input.success),
    category: validateCategory(input.category),
  };

  if (input.setup !== undefined) task.setup = validateSetup(input.setup);
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.some(t => typeof t !== 'string')) throw new Error('tags must be string[]');
    task.tags = input.tags;
  }
  if (input.expectedFirstTool !== undefined) task.expectedFirstTool = requiredString(input.expectedFirstTool, 'expectedFirstTool');
  return task;
}

function validateCategory(input: unknown): EpisodeTaskCategory {
  if (input === undefined) return 'info_retrieval';
  if (typeof input !== 'string' || !TASK_CATEGORIES.has(input as EpisodeTaskCategory)) {
    throw new Error(`category must be one of: ${Array.from(TASK_CATEGORIES).join(', ')}`);
  }
  return input as EpisodeTaskCategory;
}

export function normalizeTaskSpecs(inputs: EpisodeTaskSpec[]): NormalizedEpisodeTaskSpec[] {
  return inputs.map(normalizeTaskSpec);
}

function validateSetup(input: unknown): NonNullable<EpisodeTaskSpec['setup']> {
  if (!isRecord(input)) throw new Error('setup must be an object');
  rejectUnknownKeys(input, SETUP_KEYS, 'setup');
  const setup: NonNullable<EpisodeTaskSpec['setup']> = {};
  if (input.clearCookies !== undefined) {
    if (typeof input.clearCookies !== 'boolean') throw new Error('setup.clearCookies must be boolean');
    setup.clearCookies = input.clearCookies;
  }
  if (input.viewport !== undefined) {
    if (!isRecord(input.viewport)) throw new Error('setup.viewport must be an object');
    rejectUnknownKeys(input.viewport, VIEWPORT_KEYS, 'setup.viewport');
    const width = numberWithDefault(input.viewport.width, 0, 'setup.viewport.width');
    const height = numberWithDefault(input.viewport.height, 0, 'setup.viewport.height');
    setup.viewport = { width, height };
  }
  return setup;
}

function validateAssertion(input: unknown): Assertion {
  if (!isRecord(input)) throw new Error('success must be an assertion object');
  if (typeof input.kind !== 'string') throw new Error('success.kind is required');
  switch (input.kind) {
    case 'url':
      rejectUnknownKeys(input, new Set(['kind', 'pattern']), 'url assertion');
      requiredString(input.pattern, 'pattern');
      break;
    case 'dom_text':
      rejectUnknownKeys(input, new Set(['kind', 'selector', 'contains']), 'dom_text assertion');
      if (input.selector !== undefined) requiredString(input.selector, 'selector');
      requiredString(input.contains, 'contains');
      break;
    case 'dom_count':
      rejectUnknownKeys(input, new Set(['kind', 'selector', 'op', 'value']), 'dom_count assertion');
      requiredString(input.selector, 'selector');
      if (!['eq', 'gte', 'lte'].includes(String(input.op))) throw new Error('dom_count.op is invalid');
      numberWithDefault(input.value, 0, 'dom_count.value');
      break;
    case 'and':
    case 'or':
      rejectUnknownKeys(input, new Set(['kind', 'children']), `${input.kind} assertion`);
      if (!Array.isArray(input.children) || input.children.length === 0) throw new Error(`${input.kind}.children must be non-empty`);
      input.children.forEach(validateAssertion);
      break;
    case 'not':
      rejectUnknownKeys(input, new Set(['kind', 'child']), 'not assertion');
      validateAssertion(input.child);
      break;
    default:
      throw new Error(`unsupported assertion kind: ${input.kind}`);
  }
  return input as unknown as Assertion;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value;
}

function numberWithDefault(value: unknown, fallback: number, field: string): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved <= 0) throw new Error(`${field} must be a positive number`);
  return resolved;
}

function rejectUnknownKeys(input: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(input).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown field(s): ${unknown.join(', ')}`);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
