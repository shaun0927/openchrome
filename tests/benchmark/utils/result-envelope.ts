/**
 * Result-envelope builder + validator for the competitive benchmark suite.
 *
 * Every benchmark axis (#A-#F) wraps its rows in this envelope before writing
 * JSON, so every published number carries environment metadata and competitor
 * version pins. The canonical spec is `tests/benchmark/schemas/result.schema.json`;
 * this module enforces the same shape at runtime without pulling in a JSON-schema
 * dependency.
 */

import type { EnvironmentMetadata } from './environment';
import { TOKENIZER_ENCODING } from './tokenizer';

export const RESULT_SCHEMA_VERSION = '1.0.0';

export type BenchmarkAxis =
  | 'foundation'
  | 'token-efficiency'
  | 'agent-success'
  | 'speed-throughput'
  | 'reliability'
  | 'auth-usability'
  | 'developer-experience'
  | 'realworld-task-completion';

export interface CompetitorPin {
  name: string;
  version: string;
  commit?: string;
  measuredAt?: string;
}

export interface ResultEnvelope<TRow = unknown> {
  axis: BenchmarkAxis;
  schemaVersion: string;
  environment: EnvironmentMetadata;
  competitors: CompetitorPin[];
  tokenizer: string;
  results: TRow[];
}

export interface BuildResultEnvelopeInput<TRow> {
  axis: BenchmarkAxis;
  environment: EnvironmentMetadata;
  competitors: CompetitorPin[];
  results: TRow[];
}

export function buildResultEnvelope<TRow>(
  input: BuildResultEnvelopeInput<TRow>,
): ResultEnvelope<TRow> {
  return {
    axis: input.axis,
    schemaVersion: RESULT_SCHEMA_VERSION,
    environment: input.environment,
    competitors: input.competitors,
    tokenizer: TOKENIZER_ENCODING,
    results: input.results,
  };
}

const VALID_AXES: ReadonlySet<string> = new Set<BenchmarkAxis>([
  'foundation',
  'token-efficiency',
  'agent-success',
  'speed-throughput',
  'reliability',
  'auth-usability',
  'developer-experience',
  'realworld-task-completion',
]);

const REQUIRED_ENV_KEYS = [
  'capturedAt',
  'gitSha',
  'gitDirty',
  'nodeVersion',
  'os',
  'arch',
  'cpuModel',
  'cpuCount',
  'totalMemoryBytes',
  'chromeVersion',
  'networkProfile',
] as const;

/**
 * Structural validation matching `result.schema.json`. Returns the list of
 * problems found — empty array means valid. Runners should assert this is
 * empty before writing the file.
 */
export function validateResultEnvelope(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return ['envelope is not an object'];
  }
  const env = value as Record<string, unknown>;

  if (typeof env.axis !== 'string' || !VALID_AXES.has(env.axis)) {
    problems.push(`axis must be one of ${[...VALID_AXES].join(', ')}`);
  }
  if (typeof env.schemaVersion !== 'string') {
    problems.push('schemaVersion must be a string');
  }
  if (typeof env.tokenizer !== 'string' || env.tokenizer.length === 0) {
    problems.push('tokenizer must be a non-empty string');
  }

  if (typeof env.environment !== 'object' || env.environment === null) {
    problems.push('environment must be an object');
  } else {
    const envMeta = env.environment as Record<string, unknown>;
    for (const key of REQUIRED_ENV_KEYS) {
      if (!(key in envMeta)) {
        problems.push(`environment.${key} is required`);
      }
    }
  }

  if (!Array.isArray(env.competitors) || env.competitors.length === 0) {
    problems.push('competitors must be a non-empty array');
  } else {
    env.competitors.forEach((entry, i) => {
      if (typeof entry !== 'object' || entry === null) {
        problems.push(`competitors[${i}] must be an object`);
        return;
      }
      const pin = entry as Record<string, unknown>;
      if (typeof pin.name !== 'string' || pin.name.length === 0) {
        problems.push(`competitors[${i}].name must be a non-empty string`);
      }
      if (typeof pin.version !== 'string' || pin.version.length === 0) {
        problems.push(`competitors[${i}].version must be a non-empty string`);
      }
    });
  }

  if (!Array.isArray(env.results)) {
    problems.push('results must be an array');
  }

  return problems;
}

/**
 * Throwing wrapper for runners that want a hard gate before writing output.
 */
export function assertValidResultEnvelope(value: unknown): void {
  const problems = validateResultEnvelope(value);
  if (problems.length > 0) {
    throw new Error(
      `Benchmark result envelope failed schema validation:\n  - ${problems.join('\n  - ')}`,
    );
  }
}
