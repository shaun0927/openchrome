import * as path from 'path';
import type { EpisodeAdapter, EpisodeClient, EpisodeEvent, EpisodeResult, EpisodeStatus, EpisodeTokenMetrics, EpisodeToolCall, EpisodeToolResult, NormalizedEpisodeTaskSpec } from './types';
import { TOKENIZER_ENCODING, countTokens, countTokensOfValue } from '../utils/tokenizer';
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
  const tokenMetrics: EpisodeTokenMetrics = {
    agentPromptTokens: 0,
    assistantOutputTokens: 0,
    toolArgumentTokens: 0,
    toolResultTokens: 0,
    totalTokens: 0,
    tokenizer: TOKENIZER_ENCODING,
  };
  let firstAgentTool: string | undefined;
  let lastResult: EpisodeToolResult | undefined;
  let lastToolCall: EpisodeToolCall | undefined;

  await client.reset(task);
  events.push({ ts: now(), type: 'reset', url: task.startUrl });
  const nav = await client.callTool({ tool: 'navigate', args: { url: task.startUrl } });
  toolCalls++;
  const navArgs = { url: task.startUrl };
  const navArgTokens = countTokensOfValue(navArgs);
  const navResultTokens = countTokensOfValue(nav.text ?? nav.error ?? nav.data);
  tokenMetrics.toolArgumentTokens += navArgTokens;
  tokenMetrics.toolResultTokens += navResultTokens;
  events.push({ ts: now(), type: 'tool_call', step: 0, tool: 'navigate', args: navArgs, tokenCount: navArgTokens });
  events.push({ ts: now(), type: 'tool_result', step: 0, tool: 'navigate', ok: nav.ok, text: nav.text, data: nav.data, error: nav.error, tokenCount: navResultTokens });
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
      tokenMetrics.agentPromptTokens += estimateAgentPromptTokens(task, steps, lastResult);
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
    if (firstAgentTool === undefined) firstAgentTool = next.tool;
    lastToolCall = next;
    const outputTokens = countTokensOfValue(next);
    const argTokens = countTokensOfValue(next.args);
    tokenMetrics.assistantOutputTokens += outputTokens;
    tokenMetrics.toolArgumentTokens += argTokens;
    events.push({ ts: now(), type: 'tool_call', step: steps, tool: next.tool, args: next.args, tokenCount: outputTokens + argTokens });
    lastResult = await client.callTool(next);
    const resultTokens = countTokensOfValue(lastResult.text ?? lastResult.error ?? lastResult.data);
    tokenMetrics.toolResultTokens += resultTokens;
    events.push({ ts: now(), type: 'tool_result', step: steps, tool: next.tool, ok: lastResult.ok, text: lastResult.text, data: lastResult.data, error: lastResult.error, tokenCount: resultTokens });
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
  tokenMetrics.totalTokens =
    tokenMetrics.agentPromptTokens +
    tokenMetrics.assistantOutputTokens +
    tokenMetrics.toolArgumentTokens +
    tokenMetrics.toolResultTokens;

  const result: EpisodeResult = {
    runId,
    taskId: task.id,
    category: task.category,
    status,
    success,
    steps,
    durationMs,
    toolCalls,
    openchromeErrors,
    noProgressEpisodes: countNoProgressEpisodes(events),
    firstToolSelection: {
      expected: task.expectedFirstTool,
      actual: firstAgentTool,
      ...(task.expectedFirstTool ? { correct: firstAgentTool === task.expectedFirstTool } : {}),
    },
    tokenMetrics,
    tokenUsage,
    finalUrl,
    ...(success ? {} : { failedContract }),
    artifacts: placeholderArtifacts,
  };
  const paths = writeEpisodeArtifacts(outDir, runId, events, result);
  result.artifacts.eventsJsonl = paths.eventsJsonl;
  result.artifacts.reportJson = paths.reportJson;
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

function estimateAgentPromptTokens(task: NormalizedEpisodeTaskSpec, step: number, lastResult: EpisodeToolResult | undefined): number {
  return countTokens([
    `task:${task.title}`,
    `goal:${task.goal}`,
    `category:${task.category}`,
    `step:${step}`,
    lastResult?.text ? `last_result:${lastResult.text}` : '',
    lastResult?.error ? `last_error:${lastResult.error}` : '',
  ].filter(Boolean).join('\n'));
}
