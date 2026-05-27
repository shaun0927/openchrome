export interface TargetQueueMetrics {
  enqueued: number;
  completed: number;
  rejected: number;
  cancelled: number;
  totalWaitMs: number;
  totalExecutionMs: number;
}

interface QueueItem<T> {
  enqueuedAt: number;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export class TargetQueueCancelledError extends Error {
  constructor(targetId: string) {
    super(`Target queue cancelled for closed or expired target ${targetId}`);
    this.name = 'TargetQueueCancelledError';
  }
}

export class TargetCommandQueue {
  private readonly targetId: string;
  private readonly queue: QueueItem<unknown>[] = [];
  private processing: Promise<void> | null = null;
  private closed = false;
  private readonly metrics: TargetQueueMetrics = {
    enqueued: 0,
    completed: 0,
    rejected: 0,
    cancelled: 0,
    totalWaitMs: 0,
    totalExecutionMs: 0,
  };

  constructor(targetId: string) {
    this.targetId = targetId;
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new TargetQueueCancelledError(this.targetId));
    this.metrics.enqueued++;
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ enqueuedAt: Date.now(), fn, resolve: resolve as (value: unknown) => void, reject });
      this.start();
    });
  }

  cancel(): void {
    this.closed = true;
    const error = new TargetQueueCancelledError(this.targetId);
    while (this.queue.length > 0) {
      this.queue.shift()!.reject(error);
      this.metrics.cancelled++;
    }
  }

  snapshot(): TargetQueueMetrics & { targetId: string; pending: number; processing: boolean; closed: boolean } {
    return { targetId: this.targetId, pending: this.queue.length, processing: this.processing !== null, closed: this.closed, ...this.metrics };
  }

  private start(): void {
    if (!this.processing) this.processing = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.closed) {
        const item = this.queue.shift()!;
        const startedAt = Date.now();
        this.metrics.totalWaitMs += Math.max(0, startedAt - item.enqueuedAt);
        try {
          const value = await item.fn();
          this.metrics.completed++;
          this.metrics.totalExecutionMs += Math.max(0, Date.now() - startedAt);
          item.resolve(value);
        } catch (err) {
          this.metrics.rejected++;
          item.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      this.processing = null;
      if (this.queue.length > 0 && !this.closed) this.start();
    }
  }
}

export class TargetQueueManager {
  private readonly queues = new Map<string, TargetCommandQueue>();

  enqueue<T>(targetId: string, fn: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(targetId);
    if (!queue) {
      queue = new TargetCommandQueue(targetId);
      this.queues.set(targetId, queue);
    }
    return queue.enqueue(fn);
  }

  cancelTarget(targetId: string): void {
    const queue = this.queues.get(targetId);
    if (queue) {
      queue.cancel();
      this.queues.delete(targetId);
    }
  }

  /**
   * Cancel queues for any targetId not in the alive set. Mirrors the lease
   * registry reconcile path so a Chrome reconnect that loses targetIds does
   * not leave per-target queues orphaned in memory.
   */
  reconcileAliveTargetIds(aliveTargetIds: Set<string>): string[] {
    const cancelled: string[] = [];
    for (const targetId of Array.from(this.queues.keys())) {
      if (!aliveTargetIds.has(targetId)) {
        this.cancelTarget(targetId);
        cancelled.push(targetId);
      }
    }
    return cancelled;
  }

  getStats(): Array<ReturnType<TargetCommandQueue['snapshot']>> {
    return Array.from(this.queues.values()).map((queue) => queue.snapshot());
  }
}
