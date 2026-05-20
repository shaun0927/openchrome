/// <reference types="jest" />

import { WEBVOYAGER_BUDGET } from './budget';
import { buildProviderRunMetadata, preflightProviderRun, providerForAdapter } from './provider';

describe('LLM provider metadata and preflight', () => {
  test('maps runner adapters to provider names', () => {
    expect(providerForAdapter('claude')).toBe('anthropic');
    expect(providerForAdapter('openai')).toBe('openai');
  });

  test('pins provider, model, temperature, and budget metadata', () => {
    const metadata = buildProviderRunMetadata({
      provider: 'openai',
      model: 'gpt-test',
      temperature: 0,
      budget: WEBVOYAGER_BUDGET,
    });
    expect(metadata).toEqual({
      provider: 'openai',
      model: 'gpt-test',
      temperature: 0,
      budget: WEBVOYAGER_BUDGET,
    });
  });

  test('fails closed when explicit live env or provider key is absent', () => {
    const metadata = buildProviderRunMetadata({ provider: 'anthropic', budget: WEBVOYAGER_BUDGET });
    const result = preflightProviderRun(metadata, {});
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['OPENCHROME_BENCH_REAL=1', 'ANTHROPIC_API_KEY']);
  });

  test('passes when live env, provider key, and model metadata are present', () => {
    const metadata = buildProviderRunMetadata({ provider: 'openai', model: 'gpt-test', budget: WEBVOYAGER_BUDGET });
    const result = preflightProviderRun(metadata, { OPENCHROME_BENCH_REAL: '1', OPENAI_API_KEY: 'sk-test' });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
