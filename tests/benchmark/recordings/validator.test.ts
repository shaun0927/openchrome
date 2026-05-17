import { validateRecordingCorpus } from './validator';
import type { RecordingManifest, RecordingRun } from './schema';

const manifest = (): RecordingManifest => ({
  schemaVersion: 'recording-corpus/v1',
  corpusId: 'local-smoke-2026-05-17',
  capturedAt: '2026-05-17T00:00:00.000Z',
  operator: 'ci',
  environment: { os: 'darwin', chromeVersion: '124.0.0.0', nodeVersion: 'v20.0.0' },
  llm: { provider: 'openai', model: 'gpt-test', temperature: 0, maxSteps: 8 },
  competitors: {
    openchrome: { version: 'abc123', source: 'git-sha' },
    'playwright-mcp': { version: '1.0.0', source: 'package-lock' },
  },
  redaction: { secretsRemoved: true, reviewedBy: 'ci' },
});

const run = (): RecordingRun => ({
  taskId: 'checkout-product',
  library: 'openchrome',
  mode: 'recorded-real',
  success: true,
  finalPostconditionEvidence: 'cart contains the requested product',
  tokens: 123,
  usd: 0.0042,
  wallTimeMs: 1500,
  toolCalls: 5,
  failureCategory: null,
  artifactRefs: ['artifacts/session.jsonl'],
});

describe('recording corpus validator', () => {
  it('accepts a complete redacted recorded-real corpus', () => {
    const result = validateRecordingCorpus(manifest(), [run(), { ...run(), library: 'playwright-mcp' }]);

    expect(result.valid).toBe(true);
    expect(result.sampleCount).toBe(2);
    expect(result.libraries).toEqual(['openchrome', 'playwright-mcp']);
  });

  it('rejects runs without final postcondition evidence', () => {
    const result = validateRecordingCorpus(manifest(), [{ ...run(), finalPostconditionEvidence: '' }]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('runs[0].finalPostconditionEvidence is required');
  });

  it('rejects secret-like payloads before corpus publication', () => {
    const result = validateRecordingCorpus(
      { ...manifest(), operator: 'sk-proj-not-a-real-key' },
      [run()],
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('recording corpus contains secret-like text');
  });

  it('requires every recorded library to have a pinned competitor version', () => {
    const incomplete = manifest();
    delete incomplete.competitors.openchrome;

    const result = validateRecordingCorpus(incomplete, [run()]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('manifest.competitors.openchrome.version is required for recorded run');
  });
});
