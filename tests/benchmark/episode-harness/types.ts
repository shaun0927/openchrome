import type { Assertion, EvaluationResult } from '../../../src/contracts/types';
import type { EpisodeClaimEligibility } from './claim-eligibility';

export type EpisodeTaskCategory =
  | 'info_retrieval'
  | 'multi_step_navigation'
  | 'form_fill'
  | 'transactional_mock'
  | 'recovery'
  | 'dynamic_ui'
  | 'long_horizon';

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
  /** Taxonomy bucket for Agent Task Success reporting. */
  category?: EpisodeTaskCategory;
  /** Expected first agent-selected tool, excluding the harness-owned initial navigate. */
  expectedFirstTool?: string;
}

export interface NormalizedEpisodeTaskSpec extends EpisodeTaskSpec {
  maxSteps: number;
  maxDurationMs: number;
  category: EpisodeTaskCategory;
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
  /** Deterministic cl100k_base token count for text/value payloads in this event. */
  tokenCount?: number;
}

export interface EpisodeTokenMetrics {
  /** Tokens for task instructions and compact step context passed to the adapter. */
  agentPromptTokens: number;
  /** Tokens for assistant/tool-call JSON emitted by the adapter. */
  assistantOutputTokens: number;
  /** Tokens for tool argument payloads sent to browser tools. */
  toolArgumentTokens: number;
  /** Tokens for browser tool results returned to the agent loop. */
  toolResultTokens: number;
  /** Sum of prompt/output/tool argument/tool result tokens. */
  totalTokens: number;
  tokenizer: 'cl100k_base';
}

export interface FirstToolSelection {
  expected?: string;
  actual?: string;
  correct?: boolean;
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
  category: EpisodeTaskCategory;
  status: EpisodeStatus;
  success: boolean;
  steps: number;
  durationMs: number;
  toolCalls: number;
  openchromeErrors: number;
  noProgressEpisodes: number;
  firstToolSelection: FirstToolSelection;
  /** Agent-success aggregate token metrics retained for controlled workflow reporting. */
  tokenMetrics: EpisodeTokenMetrics;
  /** Episode-level token breakdown used by the token-cost benchmark axis. */
  tokenUsage: EpisodeTokenBreakdown;
  finalUrl: string;
  failedContract?: unknown;
  artifacts: {
    eventsJsonl: string;
    reportJson: string;
    screenshotDir?: string;
  };
}

export interface AgentSuccessAggregateRow {
  taskId: string;
  category: EpisodeTaskCategory;
  adapter: string;
  repetitions: number;
  samples: number;
  passed: number;
  successRate: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p50ToolCalls: number;
  p95ToolCalls: number;
  averageTotalTokens: number;
  averageToolResultTokens: number;
  firstToolAccuracy?: number;
  noProgressEpisodes: number;
}

export interface AgentSuccessSuiteReport {
  axis: 'agent-success';
  schemaVersion: '1.0.0';
  adapter: string;
  mode: 'controlled-mock';
  repetitions: number;
  totalTasks: number;
  totalSamples: number;
  passedSamples: number;
  successRate: number;
  tokenizer: 'cl100k_base';
  claimEligibility: EpisodeClaimEligibility;
  results: EpisodeResult[];
  aggregates: AgentSuccessAggregateRow[];
}
