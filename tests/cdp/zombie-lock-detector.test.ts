import { describe, expect, it } from '@jest/globals';
import { ZombieLockDetector } from '../../src/cdp/zombie-lock-detector.js';

describe('ZombieLockDetector', () => {
  it('emits owner_reclaim only after the confirmation streak', async () => {
    let clock = 1_000;
    let visible: string[] = ['t1'];
    const detector = new ZombieLockDetector(async () => visible, {
      confirmations: 2,
      registrationGraceMs: 0,
      now: () => clock,
    });
    const events: unknown[] = [];
    detector.on('owner_reclaim', (event) => events.push(event));
    detector.register('t1', 'owner-a');

    await detector.tick(); // seen
    expect(events).toHaveLength(0);

    visible = [];
    clock += 5_000;
    await detector.tick(); // missing 1
    expect(events).toHaveLength(0);

    clock += 5_000;
    await detector.tick(); // missing 2 → reclaim
    expect(events).toHaveLength(1);

    clock += 5_000;
    await detector.tick(); // stays reclaimed, no duplicate
    expect(events).toHaveLength(1);
  });

  it('respects the registration grace window', async () => {
    let clock = 0;
    const detector = new ZombieLockDetector(async () => [], {
      confirmations: 1,
      registrationGraceMs: 1_500,
      now: () => clock,
    });
    const events: unknown[] = [];
    detector.on('owner_reclaim', (event) => events.push(event));
    detector.register('t1', 'owner');

    clock = 1_000;
    await detector.tick();
    expect(events).toHaveLength(0);

    clock = 2_000;
    await detector.tick();
    expect(events).toHaveLength(1);
  });

  it('surfaces probe errors without reclaiming', async () => {
    const detector = new ZombieLockDetector(async () => {
      throw new Error('cdp gone');
    }, { registrationGraceMs: 0 });
    const errors: unknown[] = [];
    const reclaims: unknown[] = [];
    detector.on('probe-error', (err) => errors.push(err));
    detector.on('owner_reclaim', (event) => reclaims.push(event));
    detector.register('t1', 'owner');
    await detector.tick();
    expect(errors).toHaveLength(1);
    expect(reclaims).toHaveLength(0);
  });
});
