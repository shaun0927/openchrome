export interface HarnessCertificationThresholds {
  globalTimeoutMs: number;
  scenarioTimeoutMs: number;
  maxNonProgressCalls: number;
  maxStuckEvents: number;
  maxP99ToolLatencyMs: number;
  maxToolCalls: number;
}

export interface HarnessToolTraceEntry {
  tool: string;
  latencyMs: number;
  responseChars: number;
  ok: boolean;
}

export interface HarnessScenarioResult {
  scenario: string;
  success: boolean;
  toolCalls: number;
  nonProgressCalls: number;
  stuckEvents: number;
  recoveryAttempts: number;
  recoverySucceeded: boolean | null;
  durationMs: number;
  p95ToolLatencyMs?: number;
  p99ToolLatencyMs?: number;
  hints: Array<{ rule: string; severity: string }>;
  contractVerdicts?: Array<{ contractId: string; verdict: string }>;
  failureReason?: string;
  thresholds: Pick<HarnessCertificationThresholds, 'maxNonProgressCalls' | 'maxStuckEvents' | 'maxP99ToolLatencyMs' | 'maxToolCalls'>;
  toolTrace: HarnessToolTraceEntry[];
}

export interface HarnessCertificationReport {
  version: 1;
  startedAt: string;
  endedAt: string;
  server: { command: string; port: number | null; mode: 'deterministic-local-fixture' | 'real-http-mcp' };
  summary: {
    totalScenarios: number;
    passedScenarios: number;
    failedScenarios: number;
    totalDurationMs: number;
    configuredGlobalTimeoutMs: number;
  };
  scenarios: HarnessScenarioResult[];
  thresholds: HarnessCertificationThresholds;
}
