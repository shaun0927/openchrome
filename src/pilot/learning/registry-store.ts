import * as fs from 'fs/promises';
import * as path from 'path';
import type { AdapterRegistryEntry, AdapterStatus } from './types.js';
import { evaluateLearningPredictions } from './evaluation.js';
import { isRecord, isTask } from './validation.js';

export interface AdapterRegistryFile {
  readonly schema_version: 1;
  readonly adapters: readonly AdapterRegistryEntry[];
}

export interface PromoteAdapterInput {
  readonly registryPath: string;
  readonly adapterId: string;
  readonly status: Exclude<AdapterStatus, 'candidate'>;
  readonly evalReportPath: string;
  readonly datasetPath?: string;
  readonly predictionsPath?: string;
}

export async function readAdapterRegistry(registryPath: string): Promise<AdapterRegistryFile> {
  let text: string;
  try {
    text = await fs.readFile(registryPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { schema_version: 1, adapters: [] };
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed.schema_version !== 1 || !Array.isArray(parsed.adapters) || !parsed.adapters.every(isAdapterEntry)) throw new Error('invalid adapter registry');
  if (new Set(parsed.adapters.map((entry) => entry.id)).size !== parsed.adapters.length) throw new Error('duplicate adapter ID');
  return { schema_version: 1, adapters: parsed.adapters };
}

export async function writeAdapterRegistry(registryPath: string, registry: AdapterRegistryFile): Promise<void> {
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

export async function promoteAdapter(input: PromoteAdapterInput): Promise<AdapterRegistryFile> {
  if (!['disabled', 'shadow', 'assist'].includes(input.status)) throw new Error('invalid adapter status');
  const registry = await readAdapterRegistry(input.registryPath);
  const entry = registry.adapters.find((adapter) => adapter.id === input.adapterId);
  if (!entry) throw new Error('adapter not found');
  if (input.status !== 'disabled') await assertEvalReport(input, entry);
  const adapters = registry.adapters.map((entry) =>
    entry.id === input.adapterId ? { ...entry, status: input.status } : entry,
  );
  if (!adapters.some((entry) => entry.id === input.adapterId)) {
    throw new Error(`adapter not found: ${input.adapterId}`);
  }
  const next = { schema_version: 1 as const, adapters };
  await writeAdapterRegistry(input.registryPath, next);
  return next;
}

async function assertEvalReport(input: PromoteAdapterInput, entry: AdapterRegistryEntry): Promise<void> {
  if (!entry.artifact_sha256 || !input.datasetPath || !input.predictionsPath) throw new Error('promotion requires adapter hash, dataset and predictions');
  const report: unknown = JSON.parse(await fs.readFile(input.evalReportPath, 'utf8'));
  const computed = await evaluateLearningPredictions({ datasetPath: input.datasetPath, predictionsPath: input.predictionsPath,
    adapterId: entry.id, artifactSha256: entry.artifact_sha256 });
  if (!isRecord(report) || !computed.ok_to_promote || computed.task !== entry.task) throw new Error('promotion quality gate failed');
  for (const [key, value] of Object.entries(computed)) {
    if (key !== 'generated_at' && JSON.stringify(report[key]) !== JSON.stringify(value)) throw new Error(`eval report mismatch: ${key}`);
  }
}

function isAdapterEntry(value: unknown): value is AdapterRegistryEntry {
  if (!isRecord(value) || typeof value.id !== 'string' || !isTask(value.task) || typeof value.base_model !== 'string' || typeof value.created_at !== 'string') return false;
  if (!['candidate', 'shadow', 'assist', 'disabled'].includes(String(value.status)) || !isRecord(value.metrics)) return false;
  return ['accuracy', 'highConfidencePrecision', 'abstainRate'].every((key) => {
    const metric = value.metrics;
    return isRecord(metric) && typeof metric[key] === 'number' && Number.isFinite(metric[key]) && metric[key] >= 0 && metric[key] <= 1;
  }) && (value.artifact_sha256 === undefined || typeof value.artifact_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.artifact_sha256));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
