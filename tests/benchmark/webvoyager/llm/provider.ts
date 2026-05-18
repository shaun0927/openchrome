import type { BudgetCaps } from './budget';

export type LlmProviderName = 'anthropic' | 'openai';

export interface ProviderRunMetadata {
  provider: LlmProviderName;
  model: string;
  temperature: number;
  budget: BudgetCaps;
}

export interface ProviderPreflight {
  ok: boolean;
  provider: LlmProviderName;
  model: string;
  missing: string[];
}

const DEFAULT_MODELS: Record<LlmProviderName, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5.5',
};

const API_KEY_ENV: Record<LlmProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export function providerForAdapter(adapter: 'claude' | 'openai'): LlmProviderName {
  return adapter === 'claude' ? 'anthropic' : 'openai';
}

export function buildProviderRunMetadata(input: {
  provider: LlmProviderName;
  model?: string;
  temperature?: number;
  budget: BudgetCaps;
}): ProviderRunMetadata {
  const temperature = input.temperature ?? 0;
  if (!Number.isFinite(temperature) || temperature < 0) throw new Error('temperature must be a non-negative number');
  return {
    provider: input.provider,
    model: input.model ?? DEFAULT_MODELS[input.provider],
    temperature,
    budget: input.budget,
  };
}

export function preflightProviderRun(
  metadata: ProviderRunMetadata,
  env: NodeJS.ProcessEnv = process.env,
): ProviderPreflight {
  const missing: string[] = [];
  if (env.OPENCHROME_BENCH_REAL !== '1') missing.push('OPENCHROME_BENCH_REAL=1');
  if (!env[API_KEY_ENV[metadata.provider]]) missing.push(API_KEY_ENV[metadata.provider]);
  if (!metadata.model.trim()) missing.push('model');
  return {
    ok: missing.length === 0,
    provider: metadata.provider,
    model: metadata.model,
    missing,
  };
}
