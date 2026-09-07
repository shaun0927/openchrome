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
  cleanup: () => void;
  options: TargetQueueOptions;
}

export interface TargetQueueOptions {
  /** Absolute deadline for admission, not proof that an in-flight action was stopped. */
  deadline?: number;
  signal?: AbortSignal;
}

export class TargetQueueAdmissionError extends Error {
  readonly execution = 'not_started';
  constructor(readonly code: 'QUEUE_FULL' | 'QUEUE_DEADLINE' | 'QUEUE_ABORTED', targetId: string) {
    super(`${code}: command for target ${targetId} was not started`);
    this.name = 'TargetQueueAdmissionError';
  }
}

export class TargetQueueCancelledError extends Error {
  readonly execution = 'not_started';
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

  constructor(targetId: string, private readonly maxPending = 128, private readonly maxQueueWaitMs = 120_000) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || !Number.isFinite(maxQueueWaitMs) || maxQueueWaitMs <= 0) {
      throw new Error('Invalid target queue limits');
    }
    this.targetId = targetId;
  }

  enqueue<T>(fn: () => Promise<T>, options: TargetQueueOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new TargetQueueCancelledError(this.targetId));
    if (options.deadline !== undefined && !Number.isFinite(options.deadline)) return Promise.reject(new Error('Invalid queue deadline'));
    const now = Date.now();
    const deadline = Math.min(options.deadline ?? Infinity, now + this.maxQueueWaitMs);
    const code = options.signal?.aborted ? 'QUEUE_ABORTED' : deadline <= now ? 'QUEUE_DEADLINE' : this.queue.length >= this.maxPending ? 'QUEUE_FULL' : undefined;
    if (code) {
      this.metrics.rejected++;
      return Promise.reject(new TargetQueueAdmissionError(code, this.targetId));
    }
    this.metrics.enqueued++;
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<unknown> = {
        enqueuedAt: now, fn, resolve: resolve as (value: unknown) => void, reject,
        options: { ...options, deadline }, cleanup: () => undefined,
      };
      const remove = (reason: 'QUEUE_DEADLINE' | 'QUEUE_ABORTED'): void => {
        const index = this.queue.indexOf(item);
        if (index === -1) return; // Already executing: do not invent cancellation.
        this.queue.splice(index, 1);
        item.cleanup();
        this.metrics.rejected++;
        reject(new TargetQueueAdmissionError(reason, this.targetId));
      };
      const abort = (): void => remove('QUEUE_ABORTED');
      const timer = setTimeout(() => remove('QUEUE_DEADLINE'), Math.min(deadline - now, 2_147_483_647));
      timer.unref?.();
      item.cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
      options.signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(item);
      this.start();
    });
  }

  /**
   * Cancel queued commands and mark the queue closed.
   *
   * In-flight work is intentionally NOT aborted: once `drain` has popped an
   * item and awaits its `fn()`, that promise runs to completion so callers
   * who already issued a CDP command see its result (or its native error)
   * rather than a phantom cancellation. Only items still pending in the
   * queue at cancellation time are rejected with `TargetQueueCancelledError`.
   * After `cancel()`, future `enqueue` calls reject immediately.
   */
  cancel(): void {
    this.closed = true;
    const error = new TargetQueueCancelledError(this.targetId);
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.cleanup();
      item.reject(error);
      this.metrics.cancelled++;
    }
  }

  snapshot(): TargetQueueMetrics & { targetId: string; pending: number; processing: boolean; closed: boolean } {
    return { targetId: this.targetId, pending: this.queue.length, processing: this.processing !== null, closed: this.closed, ...this.metrics };
  }

  private start(): void {
    if (!this.processing) {
      // Set the running marker before invoking user work, including synchronous throws.
      this.processing = Promise.resolve();
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.closed) {
        const item = this.queue.shift()!;
        item.cleanup();
        const startedAt = Date.now();
        this.metrics.totalWaitMs += Math.max(0, startedAt - item.enqueuedAt);
        try {
          if (item.options.signal?.aborted) throw new TargetQueueAdmissionError('QUEUE_ABORTED', this.targetId);
          if (startedAt >= item.options.deadline!) throw new TargetQueueAdmissionError('QUEUE_DEADLINE', this.targetId);
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

  enqueue<T>(targetId: string, fn: () => Promise<T>, options?: TargetQueueOptions): Promise<T> {
    let queue = this.queues.get(targetId);
    if (!queue) {
      queue = new TargetCommandQueue(targetId);
      this.queues.set(targetId, queue);
    }
    return queue.enqueue(fn, options);
  }

  /**
   * Cancel a target's queue but keep the closed instance in the map. Any
   * caller that races a concurrent target-close (e.g. reads `targetToWorker`
   * before `onTargetClosed` clears it, then calls `enqueue` after) will hit
   * the already-closed instance and receive `TargetQueueCancelledError`
   * instead of silently resurrecting a fresh queue on a dead target. The
   * tombstone is removed by `reconcileAliveTargetIds` when Chrome confirms
   * the targetId is truly gone.
   */
  cancelTarget(targetId: string): void {
    const queue = this.queues.get(targetId);
    if (queue) {
      queue.cancel();
    }
  }

  /**
   * Cancel queues for any targetId not in the alive set and remove their
   * tombstones from the map. Mirrors the lease registry reconcile path so a
   * Chrome reconnect that loses targetIds does not leave per-target queues
   * (or their post-cancel tombstones) orphaned in memory.
   */
  reconcileAliveTargetIds(aliveTargetIds: Set<string>): string[] {
    const cancelled: string[] = [];
    for (const targetId of Array.from(this.queues.keys())) {
      if (!aliveTargetIds.has(targetId)) {
        const queue = this.queues.get(targetId);
        if (queue) queue.cancel();
        this.queues.delete(targetId);
        cancelled.push(targetId);
      }
    }
    return cancelled;
  }

  getStats(): Array<ReturnType<TargetCommandQueue['snapshot']>> {
    return Array.from(this.queues.values()).map((queue) => queue.snapshot());
  }
}
