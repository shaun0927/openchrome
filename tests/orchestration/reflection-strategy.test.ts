import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildLastAttemptSummary,
  buildReflectionStrategyMetadata,
  parseReflectionStrategy,
} from '../../src/orchestration/reflection-strategy';
import { ReflectionStore } from '../../src/reflection';

describe('reflection strategy controls', () => {
  test('validates all enum values and rejects invalid values deterministically', () => {
    for (const value of ['none', 'last_attempt', 'reflection', 'last_attempt_and_reflection']) {
      expect(parseReflectionStrategy(value)).toEqual({ ok: true, value });
    }
    const invalid = parseReflectionStrategy('always_on');
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toContain('Invalid reflectionStrategy');
  });

  test('default omitted strategy parses to none for callers that opt into validation', () => {
    expect(parseReflectionStrategy(undefined)).toEqual({ ok: true, value: 'none' });
  });

  test('last_attempt summary is bounded and redacted', () => {
    const summary = buildLastAttemptSummary({ lastAttempt: `token=abc123 ${'x'.repeat(1000)}` }, 80);
    expect(summary).not.toContain('abc123');
    expect(summary?.length).toBeLessThanOrEqual(80);
  });


  test('last_attempt strategy omits summary field when no prior attempt is supplied', () => {
    const metadata = buildReflectionStrategyMetadata({
      strategy: 'last_attempt',
      planId: 'plan-a',
      params: {},
    });

    expect(metadata.lastAttemptSummary).toBeUndefined();
  });

  test('last_attempt_and_reflection caps journal summary and reflection ids', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-strategy-'));
    try {
      const store = new ReflectionStore(root);
      for (let i = 0; i < 5; i++) {
        await store.create({
          scope: { taskFingerprint: 'plan-a', domain: 'example.test' },
          trigger: 'plan_failed',
          evidence: { lastTools: ['navigate', 'interact'] },
          diagnosis: `diagnosis ${i}`,
          confidence: 0.5 + i / 100,
        });
      }

      const metadata = buildReflectionStrategyMetadata({
        strategy: 'last_attempt_and_reflection',
        planId: 'plan-a',
        params: { lastAttemptSummary: 'failed click '.repeat(100) },
        scope: { domain: 'example.test', taskFingerprint: 'plan-a' },
        store,
        maxReflections: 3,
        maxSummaryChars: 120,
      });

      expect(metadata.strategy).toBe('last_attempt_and_reflection');
      expect(metadata.reflectionIdsConsidered).toHaveLength(3);
      expect(metadata.lastAttemptSummary?.length).toBeLessThanOrEqual(120);
      expect(metadata.limits).toEqual({ maxReflections: 3, maxSummaryChars: 120 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reflection strategy reports no matching reflections without throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reflection-strategy-empty-'));
    try {
      const metadata = buildReflectionStrategyMetadata({
        strategy: 'reflection',
        planId: 'plan-missing',
        params: {},
        store: new ReflectionStore(root),
      });
      expect(metadata.reflectionIdsConsidered).toEqual([]);
      expect(metadata.noMatchingReflections).toBe(true);
      expect(metadata.lastAttemptSummary).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
