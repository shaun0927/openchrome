import type { RecordingCorpusValidation, RecordingManifest, RecordingRun } from './schema';

const SECRET_PATTERN = /(sk-ant-[A-Za-z0-9_-]{10,}|sk-proj-[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|api[_-]?key|secret|bearer\s+[A-Za-z0-9._-]{10,})/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasSecretLikeText(value: unknown): boolean {
  if (typeof value === 'string') return SECRET_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(hasSecretLikeText);
  if (isPlainObject(value)) return Object.values(value).some(hasSecretLikeText);
  return false;
}

function isIsoDate(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isFiniteNonNegative(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function validateRecordingCorpus(
  manifest: RecordingManifest,
  runs: RecordingRun[],
): RecordingCorpusValidation {
  const errors: string[] = [];

  if (!isPlainObject(manifest)) {
    return { valid: false, errors: ['manifest must be an object'], sampleCount: 0, libraries: [], taskIds: [] };
  }

  if (manifest.schemaVersion !== 'recording-corpus/v1') errors.push('manifest.schemaVersion must be recording-corpus/v1');
  if (!manifest.corpusId?.trim()) errors.push('manifest.corpusId is required');
  if (!isIsoDate(manifest.capturedAt)) errors.push('manifest.capturedAt must be an ISO-like date');
  if (!manifest.operator?.trim()) errors.push('manifest.operator is required');
  if (!manifest.environment?.os?.trim()) errors.push('manifest.environment.os is required');
  if (!manifest.environment?.chromeVersion?.trim()) errors.push('manifest.environment.chromeVersion is required');
  if (manifest.llm?.provider !== 'anthropic' && manifest.llm?.provider !== 'openai') {
    errors.push('manifest.llm.provider must be anthropic or openai');
  }
  if (!manifest.llm?.model?.trim()) errors.push('manifest.llm.model is required');
  if (!isFiniteNonNegative(manifest.llm?.temperature)) errors.push('manifest.llm.temperature must be non-negative');
  if (!Number.isInteger(manifest.llm?.maxSteps) || manifest.llm.maxSteps <= 0) {
    errors.push('manifest.llm.maxSteps must be a positive integer');
  }
  if (!manifest.redaction?.secretsRemoved) errors.push('manifest.redaction.secretsRemoved must be true');
  if (!manifest.redaction?.reviewedBy?.trim()) errors.push('manifest.redaction.reviewedBy is required');

  const competitors = manifest.competitors ?? {};
  for (const [library, version] of Object.entries(competitors)) {
    if (!library.trim()) errors.push('manifest.competitors contains an empty library key');
    if (!isPlainObject(version)) {
      errors.push(`manifest.competitors.${library} must be an object`);
      continue;
    }
    if (typeof version.version !== 'string' || !version.version.trim()) errors.push(`manifest.competitors.${library}.version is required`);
    if (typeof version.source !== 'string' || !version.source.trim()) errors.push(`manifest.competitors.${library}.source is required`);
  }

  if (!Array.isArray(runs) || runs.length === 0) errors.push('runs must contain at least one recorded episode');

  const libraries = new Set<string>();
  const taskIds = new Set<string>();
  for (const [index, maybeRun] of (Array.isArray(runs) ? runs : []).entries()) {
    const prefix = `runs[${index}]`;
    if (!isPlainObject(maybeRun)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const run = maybeRun as unknown as Partial<RecordingRun>;
    if (typeof run.taskId !== 'string' || !run.taskId.trim()) errors.push(`${prefix}.taskId is required`);
    if (typeof run.library !== 'string' || !run.library.trim()) errors.push(`${prefix}.library is required`);
    if (run.mode !== 'recorded-real') errors.push(`${prefix}.mode must be recorded-real`);
    if (typeof run.success !== 'boolean') errors.push(`${prefix}.success must be boolean`);
    if (typeof run.finalPostconditionEvidence !== 'string' || !run.finalPostconditionEvidence.trim()) errors.push(`${prefix}.finalPostconditionEvidence is required`);
    if (!isFiniteNonNegative(run.tokens)) errors.push(`${prefix}.tokens must be non-negative`);
    if (!isFiniteNonNegative(run.usd)) errors.push(`${prefix}.usd must be non-negative`);
    if (!isFiniteNonNegative(run.wallTimeMs)) errors.push(`${prefix}.wallTimeMs must be non-negative`);
    if (typeof run.toolCalls !== 'number' || !Number.isInteger(run.toolCalls) || run.toolCalls < 0) errors.push(`${prefix}.toolCalls must be a non-negative integer`);
    if (!Array.isArray(run.artifactRefs) || run.artifactRefs.length === 0) errors.push(`${prefix}.artifactRefs must not be empty`);

    if (typeof run.library === 'string' && run.library.trim()) libraries.add(run.library);
    if (typeof run.taskId === 'string' && run.taskId.trim()) taskIds.add(run.taskId);
  }

  for (const library of libraries) {
    const competitor = competitors[library];
    if (!isPlainObject(competitor) || typeof competitor.version !== 'string' || !competitor.version.trim()) {
      errors.push(`manifest.competitors.${library}.version is required for recorded run`);
    }
  }

  if (hasSecretLikeText(manifest) || hasSecretLikeText(runs)) {
    errors.push('recording corpus contains secret-like text');
  }

  return {
    valid: errors.length === 0,
    errors,
    sampleCount: Array.isArray(runs) ? runs.length : 0,
    libraries: [...libraries].sort(),
    taskIds: [...taskIds].sort(),
  };
}
