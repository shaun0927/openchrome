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

  test('rejects new enqueue after a target queue has been cancelled', async () => {
    const queue = new TargetQueueManager();
    const first = queue.enqueue('tab-1', async () => 1);
    await first;

    queue.cancelTarget('tab-1');

    // The cancelled queue is kept in the map as a tombstone so a racing
    // caller cannot silently spin up a fresh queue against a dead target.
    await expect(queue.enqueue('tab-1', async () => 2)).rejects.toBeInstanceOf(TargetQueueCancelledError);
  });

  test('in-flight work survives cancel() while pending work is rejected', async () => {
    const queue = new TargetQueueManager();
    let release!: () => void;
    const inflight = queue.enqueue('tab-1', () => new Promise<string>((resolve) => { release = () => resolve('done'); }));
    const pending = queue.enqueue('tab-1', async () => 'never');

    queue.cancelTarget('tab-1');
    release();

    await expect(inflight).resolves.toBe('done');
    await expect(pending).rejects.toBeInstanceOf(TargetQueueCancelledError);
  });

  test('reconcile drops queues whose targetId is no longer alive', async () => {
    const queue = new TargetQueueManager();
    const aliveDone = queue.enqueue('alive', async () => 1);
    const orphanWork = queue.enqueue('orphan', async () => undefined);
    await aliveDone;

    const cancelled = queue.reconcileAliveTargetIds(new Set(['alive']));

    expect(cancelled).toEqual(['orphan']);
    await expect(orphanWork).resolves.toBeUndefined();
    expect(queue.getStats().map((s) => s.targetId)).toEqual(['alive']);
  });
});
