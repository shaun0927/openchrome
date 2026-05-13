export interface VisualGroundingScenarioResult {
  name: string;
  provider: string;
  success: boolean;
  toolCalls: number;
  wrongClicks: number;
  stuckHints: number;
  latencyMs: number;
  strategyUsed: string;
  artifacts: string[];
  health?: { memoryGrowthMb: number; openTabs?: number };
}

export interface VisualGroundingReport {
  version: 1;
  runId: string;
  openchromeVersion: string;
  scenarios: VisualGroundingScenarioResult[];
  summary: { pass: boolean; failures: string[] };
}

export const REQUIRED_VISUAL_GROUNDING_SCENARIOS = [
  'dom-ax-normal',
  'poor-label-visual',
  'canvas-visual-only',
  'ambiguous-visual',
  'unsafe-visual-target',
  'provider-timeout',
  'long-running-soak',
] as const;

export type VisualGroundingScenarioName = typeof REQUIRED_VISUAL_GROUNDING_SCENARIOS[number];
