/**
 * Lightweight Prometheus metrics collector.
 * Hand-rolled text format — no prom-client dependency.
 * Supports counters, gauges, and histograms with labels.
 */

import { currentRequestContext } from '../observability/request-id';

export type MetricType = 'counter' | 'gauge' | 'histogram';

/** Max length of a tenant label value — matches issue #10 cardinality guard. */
export const MAX_TENANT_LABEL_LEN = 64;
/** Fallback label value when tenant is unknown or invalid. */
export const TENANT_UNKNOWN = 'unknown';

const TENANT_NORMALIZE_RE = /[^a-zA-Z0-9_]/g;

/**
 * Normalise a tenant ID for use as a Prometheus label:
 *   - strips non-[A-Za-z0-9_] characters
 *   - truncates to MAX_TENANT_LABEL_LEN
 *   - falls back to `unknown` when input is empty or not a string
 *
 * Keeps label cardinality bounded even if an upstream feeds a malformed
 * tenant identifier.
 */
export function normaliseTenantLabel(raw: unknown): string {
  if (typeof raw !== 'string') return TENANT_UNKNOWN;
  const cleaned = raw.replace(TENANT_NORMALIZE_RE, '').slice(0, MAX_TENANT_LABEL_LEN);
  return cleaned.length > 0 ? cleaned : TENANT_UNKNOWN;
}

/**
 * Read the `OPENCHROME_TENANT_METRICS` rollback flag. Tenant labels are
 * attached by default; operators can turn them off to restore pre-B-4
 * cardinality.
 */
export function isTenantLabelEnabled(): boolean {
  const raw = process.env.OPENCHROME_TENANT_METRICS;
  if (raw === undefined) return true;
  return raw !== 'false' && raw !== '0';
}

/**
 * Attach a `tenant` label to a metric's label bag. If `tenantId` is omitted,
 * the active RequestContext is consulted (set by HTTP transport / auth). When
 * the rollback flag is off, returns labels unchanged so existing dashboards
 * keep working without the new dimension.
 */
export function withTenantLabel(
  labels: Record<string, string>,
  tenantId?: string,
): Record<string, string> {
  if (!isTenantLabelEnabled()) return labels;
  const source = tenantId ?? currentRequestContext()?.tenantId;
  return { ...labels, tenant: normaliseTenantLabel(source) };
}

interface MetricMeta {
  name: string;
  help: string;
  type: MetricType;
}

interface LabeledValue {
  labels: Record<string, string>;
  value: number;
}

interface HistogramData {
  labels: Record<string, string>;
  sum: number;
  count: number;
  buckets: Map<number, number>; // le -> count
}

const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

export class MetricsCollector {
  private counters: Map<string, LabeledValue[]> = new Map();
  private gauges: Map<string, LabeledValue[]> = new Map();
  private histograms: Map<string, HistogramData[]> = new Map();
  private meta: Map<string, MetricMeta> = new Map();
  private histogramBuckets: Map<string, number[]> = new Map();

  /**
   * Register a counter metric.
   */
  registerCounter(name: string, help: string): void {
    this.meta.set(name, { name, help, type: 'counter' });
    if (!this.counters.has(name)) this.counters.set(name, []);
  }

  /**
   * Register a gauge metric.
   */
  registerGauge(name: string, help: string): void {
    this.meta.set(name, { name, help, type: 'gauge' });
    if (!this.gauges.has(name)) this.gauges.set(name, []);
  }

  /**
   * Register a histogram metric.
   */
  registerHistogram(name: string, help: string, buckets?: number[]): void {
    this.meta.set(name, { name, help, type: 'histogram' });
    if (!this.histograms.has(name)) this.histograms.set(name, []);
    this.histogramBuckets.set(name, buckets || DEFAULT_BUCKETS);
  }

  /**
   * Increment a counter by 1 (or by a custom amount).
   */
  inc(name: string, labels: Record<string, string> = {}, amount = 1): void {
    const entries = this.counters.get(name);
    if (!entries) return;
    const existing = entries.find(e => labelsMatch(e.labels, labels));
    if (existing) {
      existing.value += amount;
    } else {
      entries.push({ labels, value: amount });
    }
  }

  /**
   * Set a gauge to a specific value.
   */
  set(name: string, labels: Record<string, string>, value: number): void {
    const entries = this.gauges.get(name);
    if (!entries) return;
    const existing = entries.find(e => labelsMatch(e.labels, labels));
    if (existing) {
      existing.value = value;
    } else {
      entries.push({ labels, value });
    }
  }

  /**
   * Observe a value in a histogram.
   */
  observe(name: string, labels: Record<string, string>, value: number): void {
    const entries = this.histograms.get(name);
    const bucketDefs = this.histogramBuckets.get(name);
    if (!entries || !bucketDefs) return;

    let existing = entries.find(e => labelsMatch(e.labels, labels));
    if (!existing) {
      existing = {
        labels,
        sum: 0,
        count: 0,
        buckets: new Map(bucketDefs.map(b => [b, 0])),
      };
      entries.push(existing);
    }

    existing.sum += value;
    existing.count += 1;
    for (const [le] of existing.buckets) {
      if (value <= le) {
        existing.buckets.set(le, (existing.buckets.get(le) || 0) + 1);
      }
    }
  }

  /**
   * Export all metrics in Prometheus text exposition format.
   */
  export(): string {
    const lines: string[] = [];

    // Counters
    for (const [name, entries] of this.counters) {
      const m = this.meta.get(name);
      if (m) {
        lines.push(`# HELP ${name} ${m.help}`);
        lines.push(`# TYPE ${name} counter`);
      }
      for (const entry of entries) {
        lines.push(`${name}${formatLabels(entry.labels)} ${entry.value}`);
      }
    }

    // Gauges
    for (const [name, entries] of this.gauges) {
      const m = this.meta.get(name);
      if (m) {
        lines.push(`# HELP ${name} ${m.help}`);
        lines.push(`# TYPE ${name} gauge`);
      }
      for (const entry of entries) {
        lines.push(`${name}${formatLabels(entry.labels)} ${entry.value}`);
      }
    }

    // Histograms
    for (const [name, entries] of this.histograms) {
      const m = this.meta.get(name);
      if (m) {
        lines.push(`# HELP ${name} ${m.help}`);
        lines.push(`# TYPE ${name} histogram`);
      }
      for (const entry of entries) {
        const sortedBuckets = [...entry.buckets.entries()].sort((a, b) => a[0] - b[0]);
        let cumulative = 0;
        for (const [le, count] of sortedBuckets) {
          cumulative += count;
          lines.push(`${name}_bucket${formatLabels({ ...entry.labels, le: String(le) })} ${cumulative}`);
        }
        lines.push(`${name}_bucket${formatLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`);
        lines.push(`${name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
        lines.push(`${name}_count${formatLabels(entry.labels)} ${entry.count}`);
      }
    }

    return lines.join('\n') + '\n';
  }
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const pairs = keys.map(k => `${k}="${escapeLabel(labels[k])}"`).join(',');
  return `{${pairs}}`;
}

function labelsMatch(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => a[k] === b[k]);
}

// Singleton
let instance: MetricsCollector | null = null;

export function getMetricsCollector(): MetricsCollector {
  if (!instance) {
    instance = new MetricsCollector();

    // Register all OpenChrome metrics
    instance.registerCounter('openchrome_tool_calls_total', 'Total MCP tool calls');
    instance.registerHistogram('openchrome_tool_duration_seconds', 'Tool call duration in seconds',
      [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120]);
    instance.registerCounter('openchrome_reconnect_total', 'Total successful CDP reconnections');
    instance.registerGauge('openchrome_heap_bytes', 'Node.js heap usage in bytes');
    instance.registerGauge('openchrome_active_sessions', 'Current active MCP sessions');
    instance.registerGauge('openchrome_tenant_contexts_active', 'Current active tenant-scoped BrowserContexts');
    instance.registerGauge('openchrome_tabs_health', 'Tab health status count');
    instance.registerCounter('openchrome_rate_limit_rejections_total', 'Requests rejected by rate limiter');
    instance.registerCounter('openchrome_listener_errors_total', 'Async EventEmitter listener errors surfaced by safeAsyncListener');
    instance.registerCounter('openchrome_zombie_targets_cleaned_total', 'Tracked targets evicted after listener or cleanup failures');
    instance.registerCounter('openchrome_unhandled_rejections_total', 'Process-level unhandled promise rejections (safety-net counter)');
    instance.registerCounter('openchrome_cookie_scan_total', 'Cookie source scans by outcome (complete/partial/no_candidates/no_cookies)');
    instance.registerHistogram('openchrome_cookie_scan_duration_seconds', 'Cookie source scan duration in seconds',
      [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
    instance.registerHistogram('openchrome_cookie_scan_targets_scanned', 'Number of targets actually probed in each cookie scan',
      [1, 2, 5, 10, 20, 50, 100]);
    instance.registerCounter(
      'openchrome_session_init_budget_exhausted_total',
      'Session-init operations that ran out of budget, labeled by exhausting stage (A-3)',
    );
  }
  return instance;
}
