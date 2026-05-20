/// <reference types="jest" />

import { captureEnvironment } from './environment';
import {
  buildResultEnvelope,
  validateResultEnvelope,
  assertValidResultEnvelope,
  RESULT_SCHEMA_VERSION,
  isHeadlineEligibleResultStatus,
} from './result-envelope';

const env = captureEnvironment();

describe('benchmark result envelope', () => {
  test('classifies only measured/passed statuses as headline-capable', () => {
    expect(isHeadlineEligibleResultStatus('measured')).toBe(true);
    expect(isHeadlineEligibleResultStatus('passed')).toBe(true);
    expect(isHeadlineEligibleResultStatus('skipped')).toBe(false);
    expect(isHeadlineEligibleResultStatus('dry_run')).toBe(false);
    expect(isHeadlineEligibleResultStatus(undefined)).toBe(false);
  });

  test('builds a schema-valid envelope', () => {
    const envelope = buildResultEnvelope({
      axis: 'foundation',
      environment: env,
      competitors: [{ name: 'OpenChrome', version: '1.12.0' }],
      results: [{ smoke: 'ok' }],
    });

    expect(envelope.schemaVersion).toBe(RESULT_SCHEMA_VERSION);
    expect(envelope.tokenizer).toBe('cl100k_base');
    expect(validateResultEnvelope(envelope)).toEqual([]);
  });

  test('rejects a non-object', () => {
    expect(validateResultEnvelope(null)).toContain('envelope is not an object');
  });

  test('rejects an unknown axis', () => {
    const bad = buildResultEnvelope({
      axis: 'foundation',
      environment: env,
      competitors: [{ name: 'OpenChrome', version: '1.12.0' }],
      results: [],
    });
    (bad as { axis: string }).axis = 'not-an-axis';
    expect(validateResultEnvelope(bad).some((p) => p.startsWith('axis must be'))).toBe(true);
  });

  test('rejects an empty competitors array — version pins are mandatory', () => {
    const bad = buildResultEnvelope({
      axis: 'token-efficiency',
      environment: env,
      competitors: [],
      results: [],
    });
    expect(validateResultEnvelope(bad)).toContain('competitors must be a non-empty array');
  });

  test('rejects a competitor missing its version pin', () => {
    const bad = buildResultEnvelope({
      axis: 'token-efficiency',
      environment: env,
      competitors: [{ name: 'Playwright' } as unknown as { name: string; version: string }],
      results: [],
    });
    expect(validateResultEnvelope(bad).some((p) => p.includes('version must be'))).toBe(true);
  });

  test('rejects an envelope missing environment fields', () => {
    // Copy the environment first — buildResultEnvelope stores it by reference,
    // and mutating the shared `env` would poison the other tests.
    const bad = buildResultEnvelope({
      axis: 'reliability',
      environment: { ...env },
      competitors: [{ name: 'OpenChrome', version: '1.12.0' }],
      results: [],
    });
    delete (bad.environment as Partial<typeof bad.environment>).chromeVersion;
    expect(validateResultEnvelope(bad)).toContain('environment.chromeVersion is required');
  });

  test('assertValidResultEnvelope throws on invalid input', () => {
    expect(() => assertValidResultEnvelope({})).toThrow(/failed schema validation/);
  });

  test('assertValidResultEnvelope passes a valid envelope', () => {
    const ok = buildResultEnvelope({
      axis: 'speed-throughput',
      environment: env,
      competitors: [{ name: 'OpenChrome', version: '1.12.0' }],
      results: [],
    });
    expect(() => assertValidResultEnvelope(ok)).not.toThrow();
  });
});
