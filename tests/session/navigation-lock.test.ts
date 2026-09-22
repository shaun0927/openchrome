import { serializeNavigation } from '../../src/session/navigation-lock';

describe('navigation selection serialization', () => {
  it('serializes the same worker while allowing independent workers', async () => {
    const order: string[] = [];
    let release: () => void = () => { throw new Error('Gate not initialized'); };
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = serializeNavigation('worker-a', async () => { order.push('first'); await gate; });
    const second = serializeNavigation('worker-a', async () => { order.push('second'); });
    await serializeNavigation('worker-b', async () => { order.push('independent'); });
    expect(order).toEqual(['first', 'independent']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'independent', 'second']);
  });

  it('does not wedge the queue after failure', async () => {
    await expect(serializeNavigation('failure', async () => { throw new Error('expected'); })).rejects.toThrow('expected');
    await expect(serializeNavigation('failure', async () => 42)).resolves.toBe(42);
  });
});
