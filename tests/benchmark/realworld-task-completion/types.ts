export type RealWorldTaskTier = 'local-fixture' | 'stable-public-reference' | 'recovery' | 'long-horizon';

export type MeasurementMode = 'deterministic-fixture' | 'recorded-real' | 'live-llm';

export type RealWorldTaskCategory =
  | 'info_retrieval'
  | 'form_fill'
  | 'transactional_mock'
  | 'recovery'
  | 'dynamic_ui'
  | 'long_horizon';

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
  category: RealWorldTaskCategory;
  goal: string;
  maxSteps: number;
  successCriteria: string[];
  complexityTags: string[];
  requiresRecovery: boolean;
  fixturePath: string;
  resetContract: {
    kind: 'fixture-reset';
    description: string;
    evidence: string;
  };
  postconditionContract: {
    description: string;
    requiredEvidence: string[];
  };
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
  finalPostconditionEvidence?: string;
  finalPostconditionEvaluated?: boolean;
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
