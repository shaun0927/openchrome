import * as path from 'path';
import type { EpisodeAdapter, EpisodeClient, EpisodeEvent, EpisodeResult, EpisodeStatus, EpisodeToolCall, EpisodeToolResult, NormalizedEpisodeTaskSpec } from './types';
import { normalizeTaskSpec } from './spec';
import { writeEpisodeArtifacts } from './reporter';
import { summarizeEpisodeTokens } from './token-accounting';

export interface RunEpisodeOptions {
  runId?: string;
  outDir?: string;
  now?: () => number;
}

export async function runEpisode(taskInput: unknown, adapter: EpisodeAdapter, client: EpisodeClient, options: RunEpisodeOptions = {}): Promise<{ result: EpisodeResult; events: EpisodeEvent[] }> {
  const task = normalizeTaskSpec(taskInput);
  const now = options.now ?? Date.now;
  const runId = options.runId ?? makeRunId(task.id, now());
  const outDir = options.outDir ?? path.join(process.cwd(), 'tests', 'benchmark', 'episode-harness');
  const events: EpisodeEvent[] = [];
  const startedAt = now();
  let steps = 0;
  let toolCalls = 0;
  let openchromeErrors = 0;
  let status: EpisodeStatus = 'failed';
  let success = false;
  let failedContract: unknown;
  let finalUrl = '';
  let lastResult: EpisodeToolResult | undefined;
  let lastToolCall: EpisodeToolCall | undefined;

  await client.reset(task);
  events.push({ ts: now(), type: 'reset', url: task.startUrl });
  const nav = await client.callTool({ tool: 'navigate', args: { url: task.startUrl } });
  toolCalls++;
  events.push({ ts: now(), type: 'tool_call', step: 0, tool: 'navigate', args: { url: task.startUrl } });
  events.push({ ts: now(), type: 'tool_result', step: 0, tool: 'navigate', ok: nav.ok, text: nav.text, data: nav.data, error: nav.error });
  if (!nav.ok) openchromeErrors++;

  while (true) {
    const elapsed = now() - startedAt;
    if (elapsed >= task.maxDurationMs) {
      status = 'timeout';
      break;
    }
    const evalResult = await client.evaluate(task.success);
    events.push({ ts: now(), type: 'contract_eval', step: steps, evaluation: evalResult });
    if (evalResult.passed) {
      status = 'passed';
      success = true;
      break;
    }
    failedContract = evalResult.evidence;
    if (steps >= task.maxSteps) {
      status = 'max_steps';
      break;
    }

    let next: EpisodeToolCall | { done: true };
    try {
      next = await adapter.next({ task, step: steps, lastResult, events });
    } catch (err) {
      status = 'adapter_error';
      failedContract = { adapter: adapter.name, error: err instanceof Error ? err.message : String(err) };
      break;
    }
    if ('done' in next) {
      status = 'failed';
      break;
    }

    steps++;
    toolCalls++;
    lastToolCall = next;
    events.push({ ts: now(), type: 'tool_call', step: steps, tool: next.tool, args: next.args });
    lastResult = await client.callTool(next);
    events.push({ ts: now(), type: 'tool_result', step: steps, tool: next.tool, ok: lastResult.ok, text: lastResult.text, data: lastResult.data, error: lastResult.error });
    if (!lastResult.ok) {
      openchromeErrors++;
      status = 'tool_error';
      failedContract = { tool: next.tool, error: lastResult.error };
      break;
    }
  }

  finalUrl = await client.currentUrl();
  events.push({ ts: now(), type: 'stop', status, url: finalUrl, ...(lastToolCall && { tool: lastToolCall.tool }) });

  const durationMs = now() - startedAt;
  const tokenUsage = summarizeEpisodeTokens(task, events);
  const placeholderArtifacts = {
    eventsJsonl: path.join(outDir, 'events', `${runId}.jsonl`),
    reportJson: path.join(outDir, 'reports', `${runId}.json`),
  };
  const result: EpisodeResult = {
    runId,
    taskId: task.id,
    status,
    success,
    steps,
    durationMs,
    toolCalls,
    openchromeErrors,
    noProgressEpisodes: countNoProgressEpisodes(events),
    tokenUsage,
    finalUrl,
    ...(success ? {} : { failedContract }),
    artifacts: placeholderArtifacts,
  };
  const paths = writeEpisodeArtifacts(outDir, runId, events, result);
  result.artifacts.eventsJsonl = paths.eventsJsonl;
  result.artifacts.reportJson = paths.reportJson;
  writeEpisodeArtifacts(outDir, runId, events, result);
  return { result, events };
}

export async function runEpisodes(tasks: NormalizedEpisodeTaskSpec[] | unknown[], adapter: EpisodeAdapter, makeClient: () => EpisodeClient, options: RunEpisodeOptions = {}): Promise<EpisodeResult[]> {
  const results: EpisodeResult[] = [];
  for (const task of tasks) {
    const { result } = await runEpisode(task, adapter, makeClient(), options);
    results.push(result);
  }
  return results;
}

export function countNoProgressEpisodes(events: EpisodeEvent[]): number {
  let count = 0;
  let consecutiveErrors = 0;
  let previousSuccessSignature: string | null = null;
  let repeatedSuccesses = 0;
  let countedErrorRun = false;
  let countedRepeatRun = false;

  for (const event of events) {
    if (event.type !== 'tool_result') continue;
    if (!event.ok) {
      consecutiveErrors++;
      if (consecutiveErrors >= 3 && !countedErrorRun) {
        count++;
        countedErrorRun = true;
      }
      previousSuccessSignature = null;
      repeatedSuccesses = 0;
      countedRepeatRun = false;
      continue;
    }
    consecutiveErrors = 0;
    countedErrorRun = false;
    const signature = `${event.tool ?? ''}:${event.text ?? ''}`;
    if (signature === previousSuccessSignature) repeatedSuccesses++;
    else repeatedSuccesses = 1;
    previousSuccessSignature = signature;
    if (repeatedSuccesses >= 3 && !countedRepeatRun) {
      count++;
      countedRepeatRun = true;
    }
  }
  return count;
}

function makeRunId(taskId: string, now: number): string {
  return `${taskId}-${now.toString(36)}`.replace(/[^a-z0-9_-]/gi, '-');
}
