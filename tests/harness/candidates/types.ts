/** Candidate evaluation schema for recovery/hint policies (#1050). */

export type HarnessCandidateKind = 'hint_rule' | 'recovery_plan' | 'compiled_plan';

export interface HarnessCandidate {
  id: string;
  kind: HarnessCandidateKind;
  description: string;
  appliesTo: string[];
  artifactRef: string;
  safety: { productionEligible: boolean; reason: string };
  policy: {
    expectedFamilies: string[];
    toolSequence: string[];
    avoidPatterns?: string[];
  };
}

export interface HarnessScenario {
  id: string;
  failureFamily: string;
  description: string;
  expectedTools: string[];
  baselineNonProgressCalls: number;
  expectedRecoveryTimeMs: number;
  riskyText?: string;
}

export interface CandidateScore {
  candidateId: string;
  scenario: string;
  success: boolean;
  score: number;
  toolCalls: number;
  nonProgressCalls: number;
  recoveryTimeMs: number;
  safetyViolations: number;
  failureReason?: string;
  toolTrace: Array<{ tool: string; ok: boolean; reason?: string }>;
}

export interface CandidateReport {
  version: 1;
  generatedAt: string;
  server: { command: string; mode: 'deterministic-local-fixture' };
  candidates: HarnessCandidate[];
  scenarios: HarnessScenario[];
  scores: CandidateScore[];
  recommended: Array<{ candidateId: string; reason: string; bestFor: string[]; averageScore: number }>;
  rejected: Array<{ candidateId: string; reason: string }>;
  bestOverall?: { candidateId: string; averageScore: number };
  bestPerFailureFamily: Record<string, { candidateId: string; score: number }>;
}
