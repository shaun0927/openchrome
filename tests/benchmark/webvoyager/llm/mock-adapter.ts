/**
 * Deterministic transcript-replay adapter for CI.
 *
 * In v1 the mock adapter is a thin wrapper around a recorded "final page
 * state" JSONL fixture: it loads the last line of the transcript, builds
 * an `EvalContext` over that frozen state, and lets the existing contract
 * evaluator decide pass/fail.
 *
 * `replay_drift` is emitted when the transcript is malformed or its tool
 * sequence diverges from what the runner expects — today that means a
 * missing/invalid final-state entry. Once the real adapter starts emitting
 * per-step tool-call traces, this will compare expected vs. actual call
 * digests and surface drift the same way.
 *
 * The mock adapter is intentionally I/O-light: file reads only, no network.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { EvalContext, NetworkLogEntry } from '../../../../src/contracts/eval-context';
import type { NetworkSinceMarker } from '../../../../src/contracts/types';
import type { TranscriptEntry, TranscriptFinalState } from '../types';

export interface MockAdapterRunResult {
  context: EvalContext;
  tool_calls: number;
  response_bytes: number;
  drift?: string;
}

const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'transcripts');

/**
 * Load the transcript JSONL for `taskName`, validate it has a `final_state`
 * entry, and return an `EvalContext` over that state plus per-task metrics.
 *
 * Throws if the transcript file is missing — callers (the runner) catch and
 * record this as `replay_drift` with `error` populated. Returns `drift` set
 * when the transcript exists but doesn't contain a usable final state.
 */
export async function runMockTask(taskName: string): Promise<MockAdapterRunResult> {
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${taskName}.jsonl`);
  let raw: string;
  try {
    raw = await fs.readFile(transcriptPath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`transcript not found at ${transcriptPath}: ${message}`);
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return {
      context: emptyContext(),
      tool_calls: 0,
      response_bytes: 0,
      drift: 'transcript empty',
    };
  }

  const entries: TranscriptEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]) as TranscriptEntry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        context: emptyContext(),
        tool_calls: 0,
        response_bytes: 0,
        drift: `line ${i + 1} is not valid JSON: ${message}`,
      };
    }
  }

  const toolCalls = entries.filter((e) => e.kind === 'tool_call').length;
  const final = entries.find((e): e is TranscriptFinalState => e.kind === 'final_state');
  if (!final) {
    return {
      context: emptyContext(),
      tool_calls: toolCalls,
      response_bytes: raw.length,
      drift: 'transcript missing final_state entry',
    };
  }

  return {
    context: buildContext(final),
    tool_calls: toolCalls,
    response_bytes: raw.length,
  };
}

function emptyContext(): EvalContext {
  return buildContext({
    kind: 'final_state',
    url: 'about:blank',
    dom_text: {},
    dom_count: {},
    network: [],
    has_open_dialog: false,
  });
}

/**
 * Build an `EvalContext` backed by a frozen `TranscriptFinalState`. The
 * `domText` lookup falls back to `body` when no selector is supplied, mirroring
 * the contract evaluator's own default; `domCount` returns 0 when a selector
 * isn't recorded — that surfaces as a failed assertion via the evaluator
 * rather than as a runtime error, which is the desired behaviour.
 */
function buildContext(final: TranscriptFinalState): EvalContext {
  const networkEntries: NetworkLogEntry[] = final.network.map((n) => ({
    url: n.url,
    status: n.status,
    ts: n.ts,
  }));

  return {
    url: async () => final.url,
    domText: async (selector: string | undefined) => {
      const key = selector ?? 'body';
      const value = final.dom_text[key];
      return value === undefined ? null : value;
    },
    domCount: async (selector: string) => final.dom_count[selector] ?? 0,
    networkSince: async (_marker: NetworkSinceMarker) => networkEntries,
    screenshotPng: async () => null,
    hasOpenDialog: async () => final.has_open_dialog,
  };
}
