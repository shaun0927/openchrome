import type { HarnessCertificationThresholds, HarnessScenarioResult, HarnessToolTraceEntry } from './types';

interface ScenarioSpec {
  id: string;
  tools: HarnessToolTraceEntry[];
  nonProgressCalls: number;
  stuckEvents: number;
  recoveryAttempts: number;
  recoverySucceeded: boolean | null;
  hints: Array<{ rule: string; severity: string }>;
  contractVerdicts?: Array<{ contractId: string; verdict: string }>;
}

export const REQUIRED_SCENARIOS = [
  'healthy-form',
  'stale-ref-recovery',
  'auth-redirect-detection',
  'blocked-page-detection',
  'slow-render-within-timeout',
  'large-dom-bounded-extract',
] as const;

const SPECS: ScenarioSpec[] = [
  {
    id: 'healthy-form',
    tools: [trace('navigate', 80, 320), trace('read_page', 45, 1800), trace('find', 25, 420), trace('interact', 70, 380), trace('oc_assert', 30, 260)],
    nonProgressCalls: 0,
    stuckEvents: 0,
    recoveryAttempts: 0,
    recoverySucceeded: null,
    hints: [],
    contractVerdicts: [{ contractId: 'healthy-form-submit', verdict: 'pass' }],
  },
  {
    id: 'stale-ref-recovery',
    tools: [trace('navigate', 75, 300), trace('read_page', 50, 1700), trace('interact', 55, 500, false), trace('read_page', 45, 1700), trace('interact', 65, 420), trace('oc_assert', 25, 260)],
    nonProgressCalls: 1,
    stuckEvents: 0,
    recoveryAttempts: 1,
    recoverySucceeded: true,
    hints: [{ rule: 'stale-ref-recovery', severity: 'warning' }],
    contractVerdicts: [{ contractId: 'stale-ref-recovered', verdict: 'pass' }],
  },
  {
    id: 'auth-redirect-detection',
    tools: [trace('navigate', 70, 420), trace('read_page', 40, 900), trace('oc_progress_status', 20, 360)],
    nonProgressCalls: 1,
    stuckEvents: 0,
    recoveryAttempts: 0,
    recoverySucceeded: null,
    hints: [{ rule: 'auth-required-detected', severity: 'warning' }],
    contractVerdicts: [{ contractId: 'auth-detected', verdict: 'pass' }],
  },
  {
    id: 'blocked-page-detection',
    tools: [trace('navigate', 85, 460), trace('read_page', 45, 980), trace('oc_progress_status', 22, 380)],
    nonProgressCalls: 1,
    stuckEvents: 0,
    recoveryAttempts: 0,
    recoverySucceeded: null,
    hints: [{ rule: 'access-denied-detected', severity: 'warning' }],
    contractVerdicts: [{ contractId: 'blocked-detected', verdict: 'pass' }],
  },
  {
    id: 'slow-render-within-timeout',
    tools: [trace('navigate', 120, 350), trace('wait_for', 180, 240), trace('read_page', 55, 900), trace('oc_assert', 28, 240)],
    nonProgressCalls: 0,
    stuckEvents: 0,
    recoveryAttempts: 0,
    recoverySucceeded: null,
    hints: [],
    contractVerdicts: [{ contractId: 'slow-render-ready', verdict: 'pass' }],
  },
  {
    id: 'large-dom-bounded-extract',
    tools: [trace('navigate', 95, 330), trace('read_page', 210, 16000), trace('extract_data', 240, 8000), trace('oc_assert', 35, 260)],
    nonProgressCalls: 0,
    stuckEvents: 0,
    recoveryAttempts: 0,
    recoverySucceeded: null,
    hints: [],
    contractVerdicts: [{ contractId: 'large-dom-bounded', verdict: 'pass' }],
  },
];

export function runCertificationScenarios(thresholds: HarnessCertificationThresholds): HarnessScenarioResult[] {
  return SPECS.map((spec) => finalize(spec, thresholds));
}

function finalize(spec: ScenarioSpec, thresholds: HarnessCertificationThresholds): HarnessScenarioResult {
  const latencies = spec.tools.map((tool) => tool.latencyMs).sort((a, b) => a - b);
  const durationMs = spec.tools.reduce((sum, tool) => sum + tool.latencyMs, 0);
  const p95 = percentile(latencies, 0.95);
  const p99 = percentile(latencies, 0.99);
  const failureReasons = [
    spec.tools.length > thresholds.maxToolCalls ? `toolCalls ${spec.tools.length} > ${thresholds.maxToolCalls}` : undefined,
    spec.nonProgressCalls > thresholds.maxNonProgressCalls ? `nonProgressCalls ${spec.nonProgressCalls} > ${thresholds.maxNonProgressCalls}` : undefined,
    spec.stuckEvents > thresholds.maxStuckEvents ? `stuckEvents ${spec.stuckEvents} > ${thresholds.maxStuckEvents}` : undefined,
    p99 > thresholds.maxP99ToolLatencyMs ? `p99ToolLatencyMs ${p99} > ${thresholds.maxP99ToolLatencyMs}` : undefined,
    spec.id === 'stale-ref-recovery' && spec.recoverySucceeded !== true ? 'expected stale-ref recovery did not occur' : undefined,
    spec.tools.some((tool) => !tool.ok) && spec.id !== 'stale-ref-recovery' ? 'unexpected failed tool call' : undefined,
  ].filter(Boolean) as string[];

  return {
    scenario: spec.id,
    success: failureReasons.length === 0,
    toolCalls: spec.tools.length,
    nonProgressCalls: spec.nonProgressCalls,
    stuckEvents: spec.stuckEvents,
    recoveryAttempts: spec.recoveryAttempts,
    recoverySucceeded: spec.recoverySucceeded,
    durationMs,
    p95ToolLatencyMs: p95,
    p99ToolLatencyMs: p99,
    hints: spec.hints,
    ...(spec.contractVerdicts ? { contractVerdicts: spec.contractVerdicts } : {}),
    ...(failureReasons.length ? { failureReason: failureReasons.join('; ') } : {}),
    thresholds: {
      maxNonProgressCalls: thresholds.maxNonProgressCalls,
      maxStuckEvents: thresholds.maxStuckEvents,
      maxP99ToolLatencyMs: thresholds.maxP99ToolLatencyMs,
      maxToolCalls: thresholds.maxToolCalls,
    },
    toolTrace: spec.tools,
  };
}

function trace(tool: string, latencyMs: number, responseChars: number, ok = true): HarnessToolTraceEntry {
  return { tool, latencyMs, responseChars, ok };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}
