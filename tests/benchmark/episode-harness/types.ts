import type { Assertion, EvaluationResult } from '../../../src/contracts/types';

export interface EpisodeTaskSpec {
  id: string;
  title: string;
  startUrl: string;
  goal: string;
  maxSteps?: number;
  maxDurationMs?: number;
  success: Assertion;
  setup?: {
    clearCookies?: boolean;
    viewport?: { width: number; height: number };
  };
  tags?: string[];
}

export interface NormalizedEpisodeTaskSpec extends EpisodeTaskSpec {
  maxSteps: number;
  maxDurationMs: number;
}

export interface EpisodeToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface EpisodeAdapter {
  name: string;
  next(input: EpisodeAdapterInput): Promise<EpisodeToolCall | { done: true }>;
}

export interface EpisodeAdapterInput {
  task: NormalizedEpisodeTaskSpec;
  step: number;
  lastResult?: EpisodeToolResult;
  events: EpisodeEvent[];
}

export interface EpisodeToolResult {
  ok: boolean;
  text?: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface EpisodeClient {
  reset(task: NormalizedEpisodeTaskSpec): Promise<void>;
  callTool(call: EpisodeToolCall): Promise<EpisodeToolResult>;
  evaluate(assertion: Assertion): Promise<EvaluationResult>;
  currentUrl(): Promise<string>;
}

export type EpisodeStatus = 'passed' | 'failed' | 'timeout' | 'max_steps' | 'adapter_error' | 'tool_error';

export interface EpisodeEvent {
  ts: number;
  type: 'reset' | 'tool_call' | 'tool_result' | 'contract_eval' | 'stop';
  step?: number;
  tool?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  status?: EpisodeStatus;
  text?: string;
  data?: Record<string, unknown>;
  error?: string;
  url?: string;
  evaluation?: EvaluationResult;
}

export interface EpisodeTokenBreakdown {
  promptTokens: number;
  toolRequestTokens: number;
  toolResultTokens: number;
  contractTokens: number;
  responseTokens: number;
  totalTokens: number;
}

export interface EpisodeResult {
  runId: string;
  taskId: string;
  status: EpisodeStatus;
  success: boolean;
  steps: number;
  durationMs: number;
  toolCalls: number;
  openchromeErrors: number;
  noProgressEpisodes: number;
  tokenUsage: EpisodeTokenBreakdown;
  finalUrl: string;
  failedContract?: unknown;
  artifacts: {
    eventsJsonl: string;
    reportJson: string;
    screenshotDir?: string;
  };
}
