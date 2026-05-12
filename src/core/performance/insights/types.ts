/**
 * Shared types for the performance-insights v1 engine (#846).
 *
 * The engine consumes a CDP `Tracing.dataCollected` event stream — a flat
 * array of trace events shaped according to the
 * Trace Event Format (https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU).
 * Every event has at minimum:
 *   - `name: string`            — e.g. `firstContentfulPaint`, `largestContentfulPaint::Candidate`
 *   - `cat: string`             — comma-separated categories
 *   - `ph: string`              — phase ('I' instant, 'X' complete, 'B' begin, 'E' end)
 *   - `ts: number`              — wall-clock microseconds (relative to trace start)
 *   - `args?: Record<string, unknown>`
 *
 * v1 keeps the schema permissive (`Record<string, unknown>`) and lets each
 * evaluator narrow what it needs. This avoids importing
 * `chrome-devtools-frontend` types ahead of the planned vendoring follow-up.
 */

export type InsightSeverity = 'info' | 'warn' | 'critical';

/** Closed enumeration of the v1 insight names. */
export const INSIGHT_NAMES = [
  'LCPBreakdown',
  'DocumentLatency',
  'RenderBlocking',
  'CLSCulprits',
  'LongTasks',
  'ThirdParties',
] as const;

export type InsightName = (typeof INSIGHT_NAMES)[number];

/** A single trace event as captured from `Tracing.dataCollected`. */
export interface TraceEventRecord {
  name: string;
  cat?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  pid?: number;
  tid?: number;
  args?: Record<string, unknown>;
  [extra: string]: unknown;
}

/** The trace JSON document — a `{ traceEvents: TraceEventRecord[] }` envelope. */
export interface TraceDocument {
  traceEvents: TraceEventRecord[];
  metadata?: Record<string, unknown>;
}

/** Per-insight one-line summary returned in `oc_performance_insights`. */
export interface InsightSummary {
  name: InsightName;
  severity: InsightSeverity;
  one_line: string;
}

/** Detail evidence ref returned in `oc_performance_analyze`. */
export interface InsightEvidence {
  kind: 'request' | 'event' | 'metric';
  ref: string;
}

/** Drill-down detail returned in `oc_performance_analyze`. */
export interface InsightDetails {
  insight: InsightName;
  details_md: string;
  evidence: InsightEvidence[];
}

/**
 * Output of a single evaluator. The evaluator is allowed to return `null`
 * to signal "this insight does not apply to the supplied trace" — for
 * example, `LCPBreakdown` returns null when the trace has no LCP events.
 *
 * When `null`, the engine still surfaces an `info`-severity placeholder
 * with `one_line: 'no data'` so the closed-set surface stays predictable
 * for the agent.
 */
export interface EvaluatorResult {
  summary: InsightSummary;
  details: InsightDetails;
}

export type EvaluatorFn = (trace: TraceDocument) => EvaluatorResult | null;
