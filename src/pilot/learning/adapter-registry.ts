import type { AdapterMetrics, AdapterRegistryEntry, AdapterStatus, LearningTask } from './types.js';

export interface AdapterRegistryInput {
  readonly id: string;
  readonly task: LearningTask;
  readonly baseModel: string;
  readonly status: AdapterStatus;
  readonly metrics: AdapterMetrics;
  readonly createdAt?: string;
}

export function toAdapterRegistryEntry(input: AdapterRegistryInput): AdapterRegistryEntry {
  return {
    id: input.id,
    task: input.task,
    base_model: input.baseModel,
    status: input.status,
    metrics: input.metrics,
    created_at: input.createdAt ?? new Date().toISOString(),
  };
}
