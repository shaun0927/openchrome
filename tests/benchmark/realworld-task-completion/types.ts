export type RealWorldTaskTier = 'local-fixture' | 'stable-public-reference' | 'recovery' | 'long-horizon';

export type MeasurementMode = 'deterministic-fixture' | 'live-llm';

export type FailureCategory =
  | 'planning'
  | 'navigation'
  | 'grounding'
  | 'extraction'
  | 'form-entry'
  | 'auth-state'
  | 'timeout'
  | 'infrastructure'
  | 'none';

export interface RealWorldTaskSpec {
  id: string;
  title: string;
  tier: RealWorldTaskTier;
  goal: string;
  maxSteps: number;
  successCriteria: string[];
  complexityTags: string[];
  requiresRecovery: boolean;
}

export interface RealWorldTaskRun {
  library: string;
  taskId: string;
  mode: MeasurementMode;
  success: boolean;
  firstAttempt: boolean;
  recovered: boolean | null;
  wallTimeMs: number;
  toolCalls: number;
  retries: number;
  noProgressLoops: number;
  tokens: number | null;
  usd: number | null;
  failureCategory: FailureCategory;
  notes: string;
}

export interface RealWorldLibraryMetrics {
  library: string;
  mode: MeasurementMode;
  totalRuns: number;
  successRate: number;
  firstAttemptSuccessRate: number;
  recoverySuccessRate: number | null;
  meanWallTimeMs: number;
  p50WallTimeMs: number;
  p95WallTimeMs: number;
  meanToolCalls: number;
  meanRetries: number;
  meanNoProgressLoops: number;
  meanTokens: number | null;
  costPerSuccessUsd: number | null;
}
