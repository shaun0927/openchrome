import { evaluateVisualGroundingReport } from './report';
import { VisualGroundingReport, VisualGroundingScenarioResult } from './types';

function scenario(input: VisualGroundingScenarioResult): VisualGroundingScenarioResult {
  return input;
}

export function runMockVisualGroundingBenchmark(): VisualGroundingReport {
  const scenarios: VisualGroundingScenarioResult[] = [
    scenario({ name: 'dom-ax-normal', provider: 'dom', success: true, toolCalls: 2, wrongClicks: 0, stuckHints: 0, latencyMs: 42, strategyUsed: 'S1_AX', artifacts: ['artifacts/dom-ax-normal.json'] }),
    scenario({ name: 'poor-label-visual', provider: 'omniparser-http-mock', success: true, toolCalls: 3, wrongClicks: 0, stuckHints: 0, latencyMs: 77, strategyUsed: 'S7_VISUAL_GROUNDING', artifacts: ['artifacts/poor-label-visual.json'] }),
    scenario({ name: 'canvas-visual-only', provider: 'omniparser-http-mock', success: true, toolCalls: 4, wrongClicks: 0, stuckHints: 0, latencyMs: 95, strategyUsed: 'S7_VISUAL_GROUNDING', artifacts: ['artifacts/canvas-visual-only.json'] }),
    scenario({ name: 'ambiguous-visual', provider: 'omniparser-http-mock', success: true, toolCalls: 2, wrongClicks: 0, stuckHints: 1, latencyMs: 61, strategyUsed: 'blocked_ambiguous_visual', artifacts: ['artifacts/ambiguous-visual.json'] }),
    scenario({ name: 'unsafe-visual-target', provider: 'omniparser-http-mock', success: true, toolCalls: 2, wrongClicks: 0, stuckHints: 1, latencyMs: 58, strategyUsed: 'blocked_unsafe_visual', artifacts: ['artifacts/unsafe-visual-target.json'] }),
    scenario({ name: 'provider-timeout', provider: 'dom-fallback', success: true, toolCalls: 3, wrongClicks: 0, stuckHints: 0, latencyMs: 103, strategyUsed: 'S1_AX', artifacts: ['artifacts/provider-timeout.json'] }),
    scenario({ name: 'long-running-soak', provider: 'omniparser-http-mock', success: true, toolCalls: 40, wrongClicks: 0, stuckHints: 0, latencyMs: 900, strategyUsed: 'S7_VISUAL_GROUNDING', artifacts: ['artifacts/long-running-soak.json'], health: { memoryGrowthMb: 24, openTabs: 1 } }),
  ];
  return evaluateVisualGroundingReport({
    version: 1,
    runId: 'mock-visual-grounding',
    openchromeVersion: 'test',
    scenarios,
    summary: { pass: false, failures: [] },
  });
}
