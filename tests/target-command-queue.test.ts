import { TargetQueueCancelledError, TargetQueueManager } from '../src/session/target-command-queue';

describe('TargetQueueManager', () => {
  test('serializes commands for the same target', async () => {
    const queue = new TargetQueueManager();
    const events: string[] = [];

    const first = queue.enqueue('tab-1', async () => {
      events.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('first:end');
      return 1;
    });
    const second = queue.enqueue('tab-1', async () => {
      events.push('second:start');
      return 2;
    });

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  test('allows commands for different targets to run concurrently', async () => {
    const queue = new TargetQueueManager();
    const events: string[] = [];

    await Promise.all([
      queue.enqueue('tab-1', async () => {
        events.push('tab-1:start');
        await new Promise((resolve) => setTimeout(resolve, 15));
        events.push('tab-1:end');
      }),
      queue.enqueue('tab-2', async () => {
        events.push('tab-2:start');
        await new Promise((resolve) => setTimeout(resolve, 1));
        events.push('tab-2:end');
      }),
    ]);

    expect(events.indexOf('tab-2:start')).toBeLessThan(events.indexOf('tab-1:end'));
  });

  test('cancels queued commands for a closed target', async () => {
    const queue = new TargetQueueManager();
    let release!: () => void;
    const first = queue.enqueue('tab-1', async () => new Promise<void>((resolve) => { release = resolve; }));
    const second = queue.enqueue('tab-1', async () => undefined);

    queue.cancelTarget('tab-1');
    release();
    await first;
    await expect(second).rejects.toBeInstanceOf(TargetQueueCancelledError);
  });
});
