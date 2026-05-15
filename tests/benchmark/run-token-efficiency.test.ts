/// <reference types="jest" />

import { MIN_GROUND_TRUTH_FIELDS } from './token-efficiency';
import {
  TOKEN_EFFICIENCY_CORPUS,
  deterministicExtract,
} from './fixtures/token-efficiency/corpus';
import { scoreFixture, runTokenEfficiencyBenchmark } from './run-token-efficiency';
import { validateResultEnvelope, buildResultEnvelope } from './utils/result-envelope';
import { captureEnvironment } from './utils/environment';

describe('token-efficiency starter corpus', () => {
  test('every fixture ground truth has at least the minimum field count', () => {
    for (const fixture of TOKEN_EFFICIENCY_CORPUS) {
      expect(fixture.groundTruth.fields.length).toBeGreaterThanOrEqual(MIN_GROUND_TRUTH_FIELDS);
    }
  });

  test('every ground-truth value is actually present in its fixture HTML', () => {
    for (const fixture of TOKEN_EFFICIENCY_CORPUS) {
      for (const field of fixture.groundTruth.fields) {
        expect(fixture.html).toContain(field.expected);
      }
    }
  });

  test('deterministicExtract returns a structured record, not a blob', () => {
    const extracted = deterministicExtract(TOKEN_EFFICIENCY_CORPUS[0].html);
    expect(typeof extracted).toBe('object');
    expect(Object.keys(extracted).length).toBeGreaterThanOrEqual(MIN_GROUND_TRUTH_FIELDS);
  });
});

describe('scoreFixture', () => {
  test('deterministic baseline fully retains the structured fields', () => {
    for (const fixture of TOKEN_EFFICIENCY_CORPUS) {
      const row = scoreFixture(fixture);
      expect(row.retention).toBe(1);
      expect(row.fieldsRetained).toBe(row.fieldsTotal);
    }
  });

  test('payload is much smaller than raw HTML — compression ratio > 1', () => {
    for (const fixture of TOKEN_EFFICIENCY_CORPUS) {
      const row = scoreFixture(fixture);
      expect(row.payloadTokens).toBeLessThan(row.rawHtmlTokens);
      expect(row.compressionRatio).toBeGreaterThan(1);
    }
  });

  test('reports a real measured compression ratio that varies across fixtures', () => {
    // The retired hard-coded constant was a single value applied uniformly.
    // A real measurement must (a) produce a finite, > 1 ratio per fixture and
    // (b) differ across fixtures with different raw-HTML sizes — otherwise the
    // pipeline has regressed back to a uniform estimate.
    const ratios = TOKEN_EFFICIENCY_CORPUS.map((f) => scoreFixture(f).compressionRatio);
    for (const r of ratios) {
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThan(1);
    }
    const uniqueRatios = new Set(ratios.map((r) => Number(r.toFixed(6))));
    expect(uniqueRatios.size).toBeGreaterThan(1);
  });
});

describe('runTokenEfficiencyBenchmark', () => {
  test('produces one row per fixture', () => {
    const rows = runTokenEfficiencyBenchmark();
    expect(rows).toHaveLength(TOKEN_EFFICIENCY_CORPUS.length);
    expect(rows.map((r) => r.fixture).sort()).toEqual(
      TOKEN_EFFICIENCY_CORPUS.map((f) => f.name).sort(),
    );
  });

  test('rows wrap into a schema-valid result envelope', () => {
    const envelope = buildResultEnvelope({
      axis: 'token-efficiency',
      environment: captureEnvironment(),
      competitors: [{ name: 'OpenChrome', version: '1.12.0' }],
      results: runTokenEfficiencyBenchmark(),
    });
    expect(validateResultEnvelope(envelope)).toEqual([]);
  });
});
