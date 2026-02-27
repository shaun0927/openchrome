/**
 * Request Queue - Per-session FIFO queue for sequential request processing
 * Ported from extension with promise-based lock mechanism
 */

import { DEFAULT_QUEUE_ITEM_TIMEOUT_MS } from '../config/defaults';

interface QueueItem<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export class RequestQueue {
  private queue: QueueItem<unknown>[] = [];
  private processingPromise: Promise<void> | null = null;
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Add a function to the queue and return a promise for its result
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.triggerProcessing();
    });
  }

  /**
   * Trigger processing if not already running
   */
  private triggerProcessing(): void {
    if (this.processingPromise) {
      return;
    }
    this.processingPromise = this.processQueue();
  }

  /**
   * Process all items in the queue sequentially
   */
  private async processQueue(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;

        try {
          const result = await Promise.race([
            item.fn(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`Queue item timed out after ${DEFAULT_QUEUE_ITEM_TIMEOUT_MS}ms`)),
                DEFAULT_QUEUE_ITEM_TIMEOUT_MS,
              ),
            ),
          ]);
          item.resolve(result);
        } catch (error) {
          item.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.processingPromise = null;

      if (this.queue.length > 0) {
        this.triggerProcessing();
      }
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get isProcessing(): boolean {
    return this.processingPromise !== null;
  }

  clear(): void {
    const error = new Error('Queue cleared');
    for (const item of this.queue) {
      item.reject(error);
    }
    this.queue = [];
  }

  getSessionId(): string {
    return this.sessionId;
  }
}

export class RequestQueueManager {
  private queues: Map<string, RequestQueue> = new Map();

  getQueue(sessionId: string): RequestQueue {
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = new RequestQueue(sessionId);
      this.queues.set(sessionId, queue);
    }
    return queue;
  }

  enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.getQueue(sessionId).enqueue(fn);
  }

  deleteQueue(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (queue) {
      queue.clear();
      this.queues.delete(sessionId);
    }
  }

  getStats(): Map<string, { pending: number; processing: boolean }> {
    const stats = new Map<string, { pending: number; processing: boolean }>();
    for (const [sessionId, queue] of this.queues) {
      stats.set(sessionId, {
        pending: queue.pending,
        processing: queue.isProcessing,
      });
    }
    return stats;
  }
}
