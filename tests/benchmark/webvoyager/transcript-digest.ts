/**
 * Deterministic transcript argument digests for WebVoyager mock replay.
 *
 * Contract for #943: tool-call transcript entries include the exact argument
 * object observed by the recording adapter plus
 * `args_digest_sha256 = sha256(deterministicStringify(args))`. The mock
 * adapter recomputes the digest before evaluating the frozen final state so
 * transcript argument drift fails as `replay_drift` instead of silently passing.
 */

import { createHash } from 'node:crypto';

import type { TranscriptToolCall } from './types';

export interface ToolCallDigestDrift {
  expected?: string;
  actual?: string;
  tool: string;
  step_index: number;
  reason: 'missing_args' | 'missing_digest' | 'digest_mismatch';
}

export function deterministicStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

export function argsDigestSha256(args: unknown): string {
  return createHash('sha256').update(deterministicStringify(args)).digest('hex');
}

export function validateToolCallDigests(entries: TranscriptToolCall[]): ToolCallDigestDrift | undefined {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!Object.prototype.hasOwnProperty.call(entry, 'args')) {
      return {
        tool: entry.tool,
        step_index: i,
        reason: 'missing_args',
      };
    }
    if (!entry.args_digest_sha256) {
      return {
        actual: argsDigestSha256(entry.args),
        tool: entry.tool,
        step_index: i,
        reason: 'missing_digest',
      };
    }

    const actual = argsDigestSha256(entry.args);
    if (actual !== entry.args_digest_sha256) {
      return {
        expected: entry.args_digest_sha256,
        actual,
        tool: entry.tool,
        step_index: i,
        reason: 'digest_mismatch',
      };
    }
  }

  return undefined;
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableJson(item));
  }

  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const normalized = normalizeForStableJson(input[key]);
      if (normalized !== undefined) {
        output[key] = normalized;
      }
    }
    return output;
  }

  return value;
}
