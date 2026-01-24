/**
 * Tests for RequestQueue
 */

import { RequestQueue, RequestQueueManager } from '../extension/src/request-queue';

describe('RequestQueue', () => {
  let queue: RequestQueue;

  beforeEach(() => {
    queue = new RequestQueue('test-session');
  });

  test('should create queue with session ID', () => {
    expect(queue.getSessionId()).toBe('test-session');
    expect(queue.pending).toBe(0);
    expect(queue.isProcessing).toBe(false);
  });

  test('should process single request', async () => {
    const result = await queue.enqueue(() => Promise.resolve('hello'));
    expect(result).toBe('hello');
  });

  test('should process requests in order', async () => {
    const results: number[] = [];

    const promise1 = queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 50));
      results.push(1);
      return 1;
    });

    const promise2 = queue.enqueue(async () => {
      results.push(2);
      return 2;
    });

    const promise3 = queue.enqueue(async () => {
      results.push(3);
      return 3;
    });

    await Promise.all([promise1, promise2, promise3]);

    expect(results).toEqual([1, 2, 3]);
  });

  test('should handle errors without affecting other requests', async () => {
    const results: (number | string)[] = [];

    const promise1 = queue.enqueue(async () => {
      results.push(1);
      return 1;
    });

    const promise2 = queue.enqueue(async () => {
      throw new Error('test error');
    });

    const promise3 = queue.enqueue(async () => {
      results.push(3);
      return 3;
    });

    await promise1;
    await expect(promise2).rejects.toThrow('test error');
    await promise3;

    expect(results).toEqual([1, 3]);
  });

  test('should clear pending requests', async () => {
    // Add some requests but don't await them
    const promise1 = queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return 1;
    });

    const promise2 = queue.enqueue(() => Promise.resolve(2));
    const promise3 = queue.enqueue(() => Promise.resolve(3));

    // Clear the queue
    queue.clear();

    // Pending requests should be rejected
    await expect(promise2).rejects.toThrow('Queue cleared');
    await expect(promise3).rejects.toThrow('Queue cleared');

    // The first one might complete or be cleared depending on timing
  });
});

describe('RequestQueueManager', () => {
  let manager: RequestQueueManager;

  beforeEach(() => {
    manager = new RequestQueueManager();
  });

  test('should create queues for different sessions', () => {
    const queue1 = manager.getQueue('session-1');
    const queue2 = manager.getQueue('session-2');

    expect(queue1.getSessionId()).toBe('session-1');
    expect(queue2.getSessionId()).toBe('session-2');
    expect(queue1).not.toBe(queue2);
  });

  test('should return same queue for same session', () => {
    const queue1 = manager.getQueue('session-1');
    const queue2 = manager.getQueue('session-1');

    expect(queue1).toBe(queue2);
  });

  test('should enqueue to correct session queue', async () => {
    const result1 = await manager.enqueue('session-1', () => Promise.resolve('from-1'));
    const result2 = await manager.enqueue('session-2', () => Promise.resolve('from-2'));

    expect(result1).toBe('from-1');
    expect(result2).toBe('from-2');
  });

  test('should delete queue and clear pending', () => {
    const queue = manager.getQueue('session-1');
    queue.enqueue(() => new Promise((r) => setTimeout(r, 1000)));

    manager.deleteQueue('session-1');

    // Getting queue again should create a new one
    const newQueue = manager.getQueue('session-1');
    expect(newQueue).not.toBe(queue);
    expect(newQueue.pending).toBe(0);
  });

  test('should get stats for all queues', async () => {
    manager.getQueue('session-1');
    manager.getQueue('session-2');

    // Enqueue something to session-1
    manager.enqueue('session-1', () => new Promise((r) => setTimeout(r, 100)));

    const stats = manager.getStats();
    expect(stats.size).toBe(2);
    expect(stats.get('session-1')?.processing).toBe(true);
    expect(stats.get('session-2')?.pending).toBe(0);
  });
});
