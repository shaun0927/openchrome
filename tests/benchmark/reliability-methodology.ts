/**
 * Methodology contract for #1259 after the benchmark direction review.
 *
 * The primary reliability question is not "does a library survive an isolated
 * synthetic fault?" It is: can the library complete complex, realistic browser
 * tasks end-to-end, repeatedly, with falsifiable evidence? Fault injection
 * remains valuable, but as a stress mode layered onto real tasks.
 */

import { MIN_FLAKY_SAMPLE_SIZE } from './reliability';

export type ReliabilityMeasurementKind =
  | 'primary_task_success'
  | 'fault_recovery_stress'
  | 'mock_scaffold'
  | 'live_unwired_skip';

export interface ReliabilityMetricContract {
  id: string;
  priority: 'primary' | 'secondary' | 'guardrail';
  description: string;
  minimumSamples: number;
}

export interface ReliabilityFollowUpIssue {
  issue: number;
  title: string;
  purpose: string;
}

export interface ReliabilityMethodologyPlan {
  headline: string;
  primaryMetric: ReliabilityMetricContract;
  secondaryMetrics: ReliabilityMetricContract[];
  requiredTaskTaxonomy: string[];
  requiredCompetitors: string[];
  followUpIssues: ReliabilityFollowUpIssue[];
  publicationRules: string[];
}

export interface ReliabilityPublicationCandidate {
  measurementKind?: ReliabilityMeasurementKind;
  liveDriver?: boolean;
  samples?: number;
  recoveryRate?: number | null;
  flakyRate?: number | null;
  skipReason?: string;
  publishable?: boolean;
}

export const MIN_REAL_WORLD_TASK_REPETITIONS = 10;

export const REAL_WORLD_RELIABILITY_PLAN: ReliabilityMethodologyPlan = {
  headline:
    'Measure complex real-world task completion first; use fault recovery as a secondary stress mode.',
  primaryMetric: {
    id: 'real_world_task_success_rate',
    priority: 'primary',
    description:
      'Library × task × repetition contract success rate for realistic multi-step browser tasks.',
    minimumSamples: MIN_REAL_WORLD_TASK_REPETITIONS,
  },
  secondaryMetrics: [
    {
      id: 'fault_recovery_stress_rate',
      priority: 'secondary',
      description:
        'Recovery rate when first-principles faults are injected at deterministic checkpoints inside real tasks.',
      minimumSamples: MIN_REAL_WORLD_TASK_REPETITIONS,
    },
    {
      id: 'isolated_flaky_rate',
      priority: 'guardrail',
      description:
        'N >= 50 repeated isolated cells for deterministic flaky-rate resolution.',
      minimumSamples: MIN_FLAKY_SAMPLE_SIZE,
    },
    {
      id: 'long_run_resource_stability',
      priority: 'guardrail',
      description:
        'One-hour trend for Node RSS, Chrome RSS, zombie Chrome count, and success-rate drift.',
      minimumSamples: 1,
    },
  ],
  requiredTaskTaxonomy: [
    'search_filter_detail_extraction',
    'auth_or_session_workflow',
    'modal_or_cookie_banner_handling',
    'multi_page_comparison',
    'spa_async_navigation',
    'form_submit_and_validation',
  ],
  requiredCompetitors: ['openchrome', 'playwright', 'puppeteer', 'browser-use'],
  followUpIssues: [
    {
      issue: 1304,
      title: 'Benchmark #D follow-up: real-world task completion as primary reliability signal',
      purpose: 'Define and run the primary real-world task completion matrix.',
    },
    {
      issue: 1303,
      title: 'Benchmark #D follow-up: inject reliability faults inside real-world tasks',
      purpose: 'Layer deterministic fault injection onto realistic tasks and wire live library cells.',
    },
  ],
  publicationRules: [
    'Mock or scaffold rows are never publishable as measured competitive results.',
    'Live-unwired skips must carry a skip reason and null numeric metrics, not zeros.',
    'Primary claims must be based on real-world task completion rows, not isolated fault cells alone.',
    'Fault recovery is judged by the final task postcondition after injection.',
    'Native-agent and passive-wrapper modes must be reported separately.',
  ],
};

export function minimumSamplesForMeasurement(kind: ReliabilityMeasurementKind | undefined): number {
  if (kind === 'primary_task_success' || kind === 'fault_recovery_stress') {
    return MIN_REAL_WORLD_TASK_REPETITIONS;
  }
  if (kind === 'mock_scaffold' || kind === 'live_unwired_skip') return Number.POSITIVE_INFINITY;
  return 1;
}

export function isPublishableReliabilityMeasurement(row: ReliabilityPublicationCandidate): boolean {
  if (row.measurementKind === 'mock_scaffold' || row.measurementKind === 'live_unwired_skip') return false;
  if (row.skipReason) return false;
  if (row.liveDriver !== true) return false;
  if (typeof row.samples !== 'number' || row.samples < minimumSamplesForMeasurement(row.measurementKind)) {
    return false;
  }
  if (typeof row.flakyRate !== 'number' || !Number.isFinite(row.flakyRate)) return false;
  if (typeof row.recoveryRate !== 'number' || !Number.isFinite(row.recoveryRate)) return false;
  return true;
}

export function assertNoMockRowsPublishable(rows: ReliabilityPublicationCandidate[]): void {
  const offenders = rows.filter(
    (row) =>
      (row.measurementKind === 'mock_scaffold' || row.measurementKind === 'live_unwired_skip') &&
      (row.publishable === true || isPublishableReliabilityMeasurement(row)),
  );
  if (offenders.length > 0) {
    throw new Error(`mock/scaffold reliability rows cannot be publishable (${offenders.length} offender(s))`);
  }
}
