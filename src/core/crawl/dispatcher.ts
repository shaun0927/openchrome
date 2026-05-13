import * as os from 'os';

export type DispatcherMode = 'fixed' | 'adaptive';

export interface AdaptiveDispatcherOptions {
  minConcurrency?: number;
  maxConcurrency?: number;
  memoryPressureBytes?: number;
  originBackoffMs?: number;
  rateLimitStatuses?: number[];
  memoryProvider?: () => number;
}

export interface DispatcherEvent {
  reason: 'memory_pressure' | 'error_pressure' | 'origin_backoff' | 'recovery';
  from?: number;
  to?: number;
  origin?: string;
  status?: number;
  backoff_ms?: number;
  at_ms: number;
}

export interface DispatcherStats {
  mode: DispatcherMode;
  initial_concurrency: number;
  min_concurrency: number;
  max_concurrency_seen: number;
  throttle_events: DispatcherEvent[];
}

const DEFAULT_MEMORY_PRESSURE_BYTES = 500 * 1024 * 1024;
const DEFAULT_ORIGIN_BACKOFF_MS = 30_000;
const DEFAULT_RATE_LIMIT_STATUSES = new Set([429, 503]);

export class AdaptiveCrawlDispatcher {
  private currentConcurrency: number;
  private maxSeen: number;
  private active = 0;
  private successStreak = 0;
  private readonly queue: Array<() => void> = [];
  private readonly backoffUntil = new Map<string, number>();
  private readonly events: DispatcherEvent[] = [];
  private readonly startedAt = Date.now();
  private readonly minConcurrency: number;
  private readonly maxConcurrency: number;
  private readonly memoryPressureBytes: number;
  private readonly originBackoffMs: number;
  private readonly rateLimitStatuses: Set<number>;
  private readonly memoryProvider: () => number;

  constructor(initialConcurrency: number, options: AdaptiveDispatcherOptions = {}) {
    this.minConcurrency = Math.max(1, options.minConcurrency ?? 1);
    this.maxConcurrency = Math.max(this.minConcurrency, options.maxConcurrency ?? initialConcurrency);
    this.currentConcurrency = Math.max(this.minConcurrency, Math.min(this.maxConcurrency, initialConcurrency));
    this.maxSeen = this.currentConcurrency;
    this.memoryPressureBytes = options.memoryPressureBytes ?? DEFAULT_MEMORY_PRESSURE_BYTES;
    this.originBackoffMs = options.originBackoffMs ?? DEFAULT_ORIGIN_BACKOFF_MS;
    this.rateLimitStatuses = new Set(options.rateLimitStatuses ?? Array.from(DEFAULT_RATE_LIMIT_STATUSES));
    this.memoryProvider = options.memoryProvider ?? (() => os.freemem());
  }

  async run<T>(origin: string, fn: () => Promise<T>): Promise<T> {
    await this.waitForSlot(origin);
    this.active++;
    try {
      this.applyMemoryPressure();
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordError(origin, undefined);
      throw error;
    } finally {
      this.active--;
      this.releaseNext();
    }
  }

  recordResponse(origin: string, status?: number): void {
    if (status && this.rateLimitStatuses.has(status)) {
      this.backoffUntil.set(origin, Date.now() + this.originBackoffMs);
      this.events.push({
        reason: 'origin_backoff',
        origin,
        status,
        backoff_ms: this.originBackoffMs,
        at_ms: this.elapsed(),
      });
      this.reduce('error_pressure');
    }
  }

  stats(): DispatcherStats {
    return {
      mode: 'adaptive',
      initial_concurrency: this.maxConcurrency,
      min_concurrency: this.minConcurrency,
      max_concurrency_seen: this.maxSeen,
      throttle_events: [...this.events],
    };
  }

  private async waitForSlot(origin: string): Promise<void> {
    while (this.active >= this.currentConcurrency || this.isBackedOff(origin)) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
      this.releaseNext();
    }
  }

  private isBackedOff(origin: string): boolean {
    const until = this.backoffUntil.get(origin);
    if (!until) return false;
    if (Date.now() >= until) {
      this.backoffUntil.delete(origin);
      return false;
    }
    setTimeout(() => this.releaseNext(), Math.max(0, until - Date.now())).unref();
    return true;
  }

  private applyMemoryPressure(): void {
    if (this.memoryProvider() < this.memoryPressureBytes) this.reduce('memory_pressure');
  }

  private recordSuccess(): void {
    this.successStreak++;
    if (this.successStreak >= this.currentConcurrency * 2 && this.currentConcurrency < this.maxConcurrency) {
      const from = this.currentConcurrency;
      this.currentConcurrency++;
      this.maxSeen = Math.max(this.maxSeen, this.currentConcurrency);
      this.successStreak = 0;
      this.events.push({ reason: 'recovery', from, to: this.currentConcurrency, at_ms: this.elapsed() });
    }
  }

  private recordError(origin: string, status?: number): void {
    this.successStreak = 0;
    this.recordResponse(origin, status);
    this.reduce('error_pressure');
  }

  private reduce(reason: 'memory_pressure' | 'error_pressure'): void {
    if (this.currentConcurrency <= this.minConcurrency) return;
    const from = this.currentConcurrency;
    this.currentConcurrency = Math.max(this.minConcurrency, Math.ceil(this.currentConcurrency / 2));
    if (from !== this.currentConcurrency) {
      this.events.push({ reason, from, to: this.currentConcurrency, at_ms: this.elapsed() });
    }
  }

  private releaseNext(): void {
    const next = this.queue.shift();
    if (next) next();
  }

  private elapsed(): number {
    return Date.now() - this.startedAt;
  }
}

export function parseAdaptiveDispatcherOptions(raw: unknown, concurrency: number): AdaptiveDispatcherOptions {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const mb = typeof obj.memory_pressure_mb === 'number' ? obj.memory_pressure_mb : undefined;
  return {
    minConcurrency: typeof obj.min_concurrency === 'number' ? obj.min_concurrency : 1,
    maxConcurrency: typeof obj.max_concurrency === 'number' ? obj.max_concurrency : concurrency,
    memoryPressureBytes: mb !== undefined ? mb * 1024 * 1024 : undefined,
    originBackoffMs: typeof obj.origin_backoff_ms === 'number' ? obj.origin_backoff_ms : undefined,
    rateLimitStatuses: Array.isArray(obj.rate_limit_statuses)
      ? obj.rate_limit_statuses.filter((v): v is number => typeof v === 'number')
      : undefined,
  };
}
