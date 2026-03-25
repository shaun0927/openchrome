/**
 * Lightweight Prometheus metrics collector.
 * Hand-rolled text format — no prom-client dependency.
 * Supports counters, gauges, and histograms with labels.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';

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

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const pairs = keys.map(k => `${k}="${labels[k]}"`).join(',');
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
    instance.registerGauge('openchrome_tabs_health', 'Tab health status count');
    instance.registerCounter('openchrome_rate_limit_rejections_total', 'Requests rejected by rate limiter');
  }
  return instance;
}
