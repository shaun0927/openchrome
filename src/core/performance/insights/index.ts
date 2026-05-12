/**
 * Public surface for the v1 performance-insight engine (#846).
 *
 * This module is the entry point used by the MCP tools. It does not
 * import any chrome-devtools-frontend types so that the planned
 * vendoring follow-up can swap in the real engine without touching the
 * MCP tool layer.
 */

import { EVALUATORS } from './evaluators';
import {
  INSIGHT_NAMES,
  type EvaluatorResult,
  type InsightDetails,
  type InsightName,
  type InsightSummary,
  type TraceDocument,
  type TraceEventRecord,
} from './types';

export {
  INSIGHT_NAMES,
  type EvaluatorResult,
  type InsightDetails,
  type InsightName,
  type InsightSummary,
  type TraceDocument,
  type TraceEventRecord,
};

/**
 * Run every v1 evaluator over a trace document. Evaluators that return
 * `null` (no relevant trace events) are mapped to an `info`/`no data`
 * placeholder so the closed-set surface stays predictable for the
 * agent. Returns both the per-insight summary list (for
 * `oc_performance_insights`) and the keyed details map (for
 * `oc_performance_analyze`).
 */
export function evaluateInsights(trace: TraceDocument): {
  summaries: InsightSummary[];
  details: Record<InsightName, InsightDetails>;
} {
  const summaries: InsightSummary[] = [];
  const details = {} as Record<InsightName, InsightDetails>;
  for (const name of INSIGHT_NAMES) {
    const evaluator = EVALUATORS[name];
    let result: EvaluatorResult | null = null;
    try {
      result = evaluator(trace);
    } catch (err) {
      // A misbehaving evaluator must not take down the others. Surface
      // a placeholder so the agent sees the closed-set list intact.
      const message = err instanceof Error ? err.message : String(err);
      summaries.push({
        name,
        severity: 'info',
        one_line: `evaluator failed: ${message}`,
      });
      details[name] = {
        insight: name,
        details_md: `# ${name}\n\nEvaluator threw: ${message}`,
        evidence: [],
      };
      continue;
    }
    if (!result) {
      summaries.push({ name, severity: 'info', one_line: 'no data' });
      details[name] = {
        insight: name,
        details_md: `# ${name}\n\nNo trace events matched this insight.`,
        evidence: [],
      };
      continue;
    }
    summaries.push(result.summary);
    details[name] = result.details;
  }
  return { summaries, details };
}

/**
 * Build the human-readable Markdown summary surfaced as `summary_md`
 * from `oc_performance_insights`. Layout:
 *
 *   # Performance insights
 *
 *   - **LCPBreakdown** [warn] — LCP 3.2s — largest contributor: …
 *   - **DocumentLatency** [info] — Document TTFB 240ms for example.com
 *   - …
 */
export function buildSummaryMarkdown(summaries: InsightSummary[]): string {
  const lines = [`# Performance insights`, ``];
  for (const s of summaries) {
    lines.push(`- **${s.name}** [${s.severity}] — ${s.one_line}`);
  }
  return lines.join('\n');
}

/**
 * Type guard: is `name` one of the v1 insight names?
 */
export function isInsightName(name: string): name is InsightName {
  return (INSIGHT_NAMES as readonly string[]).includes(name);
}
