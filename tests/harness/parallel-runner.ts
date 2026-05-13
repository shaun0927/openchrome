import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface HarnessScenario<T = unknown> {
  id: string;
  run(signal: AbortSignal): Promise<T>;
  cleanup?(): Promise<void> | void;
}

export interface HarnessParallelRunnerOptions {
  concurrency: number;
  scenarioTimeoutMs: number;
  maxErrors: number;
  stragglerAfterMs: number;
  partialWritePath?: string;
  now?: () => number;
}

export interface HarnessCompleted<T> {
  id: string;
  result: T;
  durationMs: number;
}

export interface HarnessFailure {
  id: string;
  error: string;
  durationMs: number;
}

export interface HarnessTimeout {
  id: string;
  durationMs: number;
}

export interface HarnessStraggler {
  id: string;
  durationMs: number;
  stragglerAfterMs: number;
}

export interface HarnessScenarioSummary<T> {
  id: string;
  status: 'completed' | 'failed' | 'timedOut' | 'cancelled';
  durationMs: number;
  result?: T;
  error?: string;
}

export interface HarnessRunResult<T> {
  completed: Array<HarnessCompleted<T>>;
  failed: HarnessFailure[];
  timedOut: HarnessTimeout[];
  cancelled: boolean;
  stragglers: HarnessStraggler[];
  results: Array<HarnessScenarioSummary<T>>;
  concurrency: number;
  maxErrors: number;
  scenarioTimeoutMs: number;
  stragglerAfterMs: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

interface NormalizedOptions extends Required<Omit<HarnessParallelRunnerOptions, 'partialWritePath'>> {
  partialWritePath?: string;
}

export class HarnessParallelRunner<T = unknown> {
  private readonly options: NormalizedOptions;
  private writeChain: Promise<void> = Promise.resolve();
  private writeSeq = 0;
  private readonly activeControllers = new Set<AbortController>();
  private readonly cancellationControllers = new Set<AbortController>();

  constructor(options: HarnessParallelRunnerOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error('concurrency must be a positive integer');
    }
    if (!Number.isFinite(options.scenarioTimeoutMs) || options.scenarioTimeoutMs < 1) {
      throw new Error('scenarioTimeoutMs must be a positive number');
    }
    if (!Number.isInteger(options.maxErrors) || options.maxErrors < 1) {
      throw new Error('maxErrors must be a positive integer');
    }
    if (!Number.isFinite(options.stragglerAfterMs) || options.stragglerAfterMs < 1) {
      throw new Error('stragglerAfterMs must be a positive number');
    }

    this.options = {
      concurrency: options.concurrency,
      scenarioTimeoutMs: options.scenarioTimeoutMs,
      maxErrors: options.maxErrors,
      stragglerAfterMs: options.stragglerAfterMs,
      partialWritePath: options.partialWritePath,
      now: options.now ?? Date.now,
    };
  }

  async run(scenarios: Array<HarnessScenario<T>>): Promise<HarnessRunResult<T>> {
    const startedAtMs = this.options.now();
    const result: HarnessRunResult<T> = {
      completed: [],
      failed: [],
      timedOut: [],
      cancelled: false,
      stragglers: [],
      results: [],
      concurrency: this.options.concurrency,
      maxErrors: this.options.maxErrors,
      scenarioTimeoutMs: this.options.scenarioTimeoutMs,
      stragglerAfterMs: this.options.stragglerAfterMs,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(startedAtMs).toISOString(),
      durationMs: 0,
    };

    let nextIndex = 0;
    let active = 0;
    let errorCount = 0;

    await new Promise<void>((resolve) => {
      const launchMore = () => {
        if (result.cancelled && active === 0) {
          resolve();
          return;
        }

        while (!result.cancelled && active < this.options.concurrency && nextIndex < scenarios.length) {
          const scenario = scenarios[nextIndex++];
          active++;
          void this.runOne(scenario, result)
            .then((status) => {
              if (status === 'failed' || status === 'timedOut') {
                errorCount++;
                if (errorCount >= this.options.maxErrors) {
                  result.cancelled = nextIndex < scenarios.length || active > 1;
                  this.abortActiveScenarios();
                }
              }
            })
            .finally(() => {
              active--;
              void this.writePartial(result)
                .catch(() => undefined)
                .finally(() => {
                  if ((nextIndex >= scenarios.length || result.cancelled) && active === 0) {
                    resolve();
                  } else {
                    launchMore();
                  }
                });
            });
        }

        if (nextIndex >= scenarios.length && active === 0) {
          resolve();
        }
      };

      launchMore();
    });

    if (result.cancelled) {
      for (let i = nextIndex; i < scenarios.length; i++) {
        result.results.push({ id: scenarios[i].id, status: 'cancelled', durationMs: 0 });
      }
    }

    const endedAtMs = this.options.now();
    result.endedAt = new Date(endedAtMs).toISOString();
    result.durationMs = Math.max(0, endedAtMs - startedAtMs);
    await this.writePartial(result);
    return result;
  }

  private async runOne(
    scenario: HarnessScenario<T>,
    aggregate: HarnessRunResult<T>,
  ): Promise<'completed' | 'failed' | 'timedOut' | 'cancelled'> {
    const startedAt = this.options.now();
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let stragglerRecorded = false;
    let settled = false;

    const recordStraggler = () => {
      if (stragglerRecorded || settled) return;
      stragglerRecorded = true;
      aggregate.stragglers.push({
        id: scenario.id,
        durationMs: Math.max(0, this.options.now() - startedAt),
        stragglerAfterMs: this.options.stragglerAfterMs,
      });
    };

    const stragglerTimer = setTimeout(recordStraggler, this.options.stragglerAfterMs);
    const timeoutTimer = setTimeout(() => controller.abort(), this.options.scenarioTimeoutMs);
    stragglerTimer.unref?.();
    timeoutTimer.unref?.();

    const finish = async () => {
      settled = true;
      this.activeControllers.delete(controller);
      clearTimeout(stragglerTimer);
      clearTimeout(timeoutTimer);
      try {
        await scenario.cleanup?.();
      } catch {
        // Cleanup is best-effort for harness evidence. The original scenario
        // result remains the source of truth.
      }
    };

    try {
      const value = await scenario.run(controller.signal);
      const durationMs = Math.max(0, this.options.now() - startedAt);
      await finish();
      aggregate.completed.push({ id: scenario.id, result: value, durationMs });
      aggregate.results.push({ id: scenario.id, status: 'completed', durationMs, result: value });
      return 'completed';
    } catch (error) {
      const durationMs = Math.max(0, this.options.now() - startedAt);
      await finish();
      if (controller.signal.aborted) {
        if (this.cancellationControllers.has(controller)) {
          this.cancellationControllers.delete(controller);
          aggregate.results.push({ id: scenario.id, status: 'cancelled', durationMs, error: stringifyError(error) });
          return 'cancelled';
        }
        aggregate.timedOut.push({ id: scenario.id, durationMs });
        aggregate.results.push({ id: scenario.id, status: 'timedOut', durationMs, error: stringifyError(error) });
        return 'timedOut';
      }
      aggregate.failed.push({ id: scenario.id, error: stringifyError(error), durationMs });
      aggregate.results.push({ id: scenario.id, status: 'failed', durationMs, error: stringifyError(error) });
      return 'failed';
    }
  }

  private abortActiveScenarios(): void {
    for (const controller of this.activeControllers) {
      this.cancellationControllers.add(controller);
      controller.abort();
    }
  }

  private async writePartial(result: HarnessRunResult<T>): Promise<void> {
    if (!this.options.partialWritePath) return;
    const filePath = this.options.partialWritePath;
    const snapshot = JSON.stringify({ parallel: result }, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${this.writeSeq++}`;
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, filePath);
    });
    await this.writeChain;
  }
}

export function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
