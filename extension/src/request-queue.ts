/**
 * Request Queue - Per-session FIFO queue for sequential request processing
 * Prevents race conditions by ensuring only one CDP operation runs at a time per session
 *
 * Uses a promise-based lock mechanism to ensure atomic processing.
 */

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
   * Uses a promise-based lock to ensure atomic access
   */
  private triggerProcessing(): void {
    if (this.processingPromise) {
      // Already processing, the current processor will pick up new items
      return;
    }

    this.processingPromise = this.processQueue();
  }

  /**
   * Process all items in the queue sequentially
   * This method holds the lock until the queue is empty
   */
  private async processQueue(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;

        try {
          const result = await item.fn();
          item.resolve(result);
        } catch (error) {
          item.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      // Release the lock
      this.processingPromise = null;

      // Check if new items were added while we were finishing
      // This handles the race where items are added between queue.length check and lock release
      if (this.queue.length > 0) {
        this.triggerProcessing();
      }
    }
  }

  /**
   * Get the number of pending items
   */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Check if currently processing
   */
  get isProcessing(): boolean {
    return this.processingPromise !== null;
  }

  /**
   * Clear all pending items (reject with cancellation error)
   */
  clear(): void {
    const error = new Error('Queue cleared');
    for (const item of this.queue) {
      item.reject(error);
    }
    this.queue = [];
  }

  /**
   * Get session ID for this queue
   */
  getSessionId(): string {
    return this.sessionId;
  }
}

/**
 * Request Queue Manager - Manages queues for all sessions
 */
export class RequestQueueManager {
  private queues: Map<string, RequestQueue> = new Map();

  /**
   * Get or create a queue for a session
   */
  getQueue(sessionId: string): RequestQueue {
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = new RequestQueue(sessionId);
      this.queues.set(sessionId, queue);
    }
    return queue;
  }

  /**
   * Enqueue a function for a session
   */
  enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.getQueue(sessionId).enqueue(fn);
  }

  /**
   * Delete a session's queue
   */
  deleteQueue(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (queue) {
      queue.clear();
      this.queues.delete(sessionId);
    }
  }

  /**
   * Get stats for all queues
   */
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
