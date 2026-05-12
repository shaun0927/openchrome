/**
 * Hand-rolled Prometheus text exposition format (#839).
 *
 * Lives in `src/transports/` (tier:core) and intentionally avoids the
 * `prom-client` dependency per P5 of the Portability-Harness Contract.
 * The exposition format follows the Prometheus spec
 * (https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format):
 *   - `# HELP <name> <text>` (one per metric)
 *   - `# TYPE <name> counter|gauge`
 *   - `<name>{label1="value"} <value>`
 *
 * Numeric values are emitted without locale formatting. Label values are
 * escaped per spec (backslash, double-quote, newline). The endpoint is
 * read-only — counters are sourced from existing in-process state, never
 * persisted to disk.
 */

const ALLOWED_LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface PrometheusMetric {
  /** snake_case metric name, must match Prometheus naming rules. */
  name: string;
  /** Free-text help line. */
  help: string;
  /** Prometheus type. */
  type: 'counter' | 'gauge';
  /** Single value (gauge / counter total) — exclusive with `samples`. */
  value?: number;
  /** Multiple samples (e.g. per-tool counters). */
  samples?: Array<{ labels?: Record<string, string>; value: number }>;
}

/** Render a complete exposition document from the supplied metrics. */
export function renderPrometheusMetrics(metrics: PrometheusMetric[]): string {
  const lines: string[] = [];
  for (const m of metrics) {
    if (!ALLOWED_LABEL_RE.test(m.name)) {
      // Skip illegal names rather than poison the entire exposition.
      continue;
    }
    lines.push(`# HELP ${m.name} ${escapeHelp(m.help)}`);
    lines.push(`# TYPE ${m.name} ${m.type}`);
    if (m.samples && m.samples.length > 0) {
      for (const s of m.samples) {
        lines.push(`${m.name}${formatLabels(s.labels)} ${formatValue(s.value)}`);
      }
    } else if (typeof m.value === 'number') {
      lines.push(`${m.name} ${formatValue(m.value)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function escapeHelp(s: string): string {
  // Per spec: `\` → `\\`, `\n` → `\\n`. Help lines do not require quote
  // escaping (they are unquoted).
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatLabels(labels?: Record<string, string>): string {
  if (!labels) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(labels)) {
    if (!ALLOWED_LABEL_RE.test(k)) continue;
    parts.push(`${k}="${escapeLabelValue(v)}"`);
  }
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

function escapeLabelValue(s: string): string {
  // Per spec: `\` → `\\`, `"` → `\\"`, `\n` → `\\n`.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function formatValue(v: number): string {
  if (!Number.isFinite(v)) {
    if (Number.isNaN(v)) return 'NaN';
    return v > 0 ? '+Inf' : '-Inf';
  }
  // Integers without a decimal point, floats trimmed.
  return Number.isInteger(v) ? String(v) : String(v);
}
