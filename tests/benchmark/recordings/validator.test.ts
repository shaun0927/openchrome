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
      { ...manifest(), operator: 'sk-proj-abcdefghijklmnopqrstuvwxyz' },
      [run()],
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('recording corpus contains secret-like text');
  });

  it('does not reject benign prose that mentions secret-like words without credential values', () => {
    const benign = run();
    benign.finalPostconditionEvidence = 'secret menu item was visible to the secretary user';

    const result = validateRecordingCorpus(manifest(), [benign]);

    expect(result.valid).toBe(true);
  });

  it('does not reject benign task ids that contain sk- substrings', () => {
    const benign = run();
    benign.taskId = 'risk-9-task-1';

    const result = validateRecordingCorpus(manifest(), [benign]);

    expect(result.valid).toBe(true);
  });

  it('reports malformed competitor entries without throwing', () => {
    const malformed = { ...manifest(), competitors: { openchrome: null } } as unknown as RecordingManifest;

    const result = validateRecordingCorpus(malformed, [run()]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('manifest.competitors.openchrome must be an object');
  });

  it('reports malformed run entries without throwing', () => {
    const result = validateRecordingCorpus(manifest(), [null] as unknown as RecordingRun[]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('runs[0] must be an object');
  });

  it('reports malformed manifest strings without throwing', () => {
    const malformed = { ...manifest(), corpusId: 123, redaction: { secretsRemoved: 'yes', reviewedBy: 456 } } as unknown as RecordingManifest;

    const result = validateRecordingCorpus(malformed, [run()]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('manifest.corpusId is required');
    expect(result.errors).toContain('manifest.redaction.secretsRemoved must be true');
    expect(result.errors).toContain('manifest.redaction.reviewedBy is required');
  });

  it('restricts competitor version provenance values', () => {
    const malformed = { ...manifest(), competitors: { openchrome: { version: 'abc123', source: 'blog' } } } as unknown as RecordingManifest;

    const result = validateRecordingCorpus(malformed, [run()]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('manifest.competitors.openchrome.source must be package-lock, pip-freeze, git-sha, or manual');
  });

  it('reports non-string competitor versions without throwing', () => {
    const malformed = { ...manifest(), competitors: { openchrome: { version: 123, source: 'manual' } } } as unknown as RecordingManifest;

    const result = validateRecordingCorpus(malformed, [run()]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('manifest.competitors.openchrome.version is required for recorded run');
  });

  it('requires every recorded library to have a pinned competitor version', () => {
    const incomplete = manifest();
    delete incomplete.competitors.openchrome;

    const result = validateRecordingCorpus(incomplete, [run()]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('manifest.competitors.openchrome.version is required for recorded run');
  });
});
