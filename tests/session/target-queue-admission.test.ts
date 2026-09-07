import { TargetCommandQueue } from '../../src/session/target-command-queue';

describe('bounded target admission', () => {
  test('expired queued work rejects promptly and never executes after release', async () => {
    jest.useFakeTimers();
    try {
      const queue = new TargetCommandQueue('tab'); let release!: () => void;
      const running = queue.enqueue(() => new Promise<void>(resolve => { release = resolve; }));
      const sideEffect = jest.fn(async () => 1);
      const pending = queue.enqueue(sideEffect, { deadline: Date.now() + 20 });
      const rejection = expect(pending).rejects.toMatchObject({ code: 'QUEUE_DEADLINE', execution: 'not_started' });
      jest.advanceTimersByTime(21); await rejection; release(); await running;
      expect(sideEffect).not.toHaveBeenCalled(); expect(queue.snapshot().pending).toBe(0);
    } finally { jest.useRealTimers(); }
  });
  test('overload is bounded and cancelled waiting work releases capacity', async () => {
    const queue = new TargetCommandQueue('tab', 1); let release!: () => void;
    const running = queue.enqueue(() => new Promise<void>(resolve => { release = resolve; }));
    const abort = new AbortController();
    const waiting = queue.enqueue(async () => 1, { signal: abort.signal });
    await expect(queue.enqueue(async () => 2)).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'QUEUE_ABORTED' }); abort.abort(); await rejected;
    const replacement = queue.enqueue(async () => 3); release(); await running;
    await expect(replacement).resolves.toBe(3);
  });
  test('aborting in-flight action preserves its actual result', async () => {
    const queue = new TargetCommandQueue('tab'); const abort = new AbortController(); let release!: () => void;
    const running = queue.enqueue(() => new Promise<string>(resolve => { release = () => resolve('submitted'); }), { signal: abort.signal });
    abort.abort(); release(); await expect(running).resolves.toBe('submitted');
  });
  test('synchronous callback error does not wedge future work', async () => {
    const queue = new TargetCommandQueue('tab');
    await expect(queue.enqueue(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(queue.enqueue(async () => 42)).resolves.toBe(42);
  });
});
