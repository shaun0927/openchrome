/// <reference types="jest" />

import { TargetOwnershipRegistry } from '../../src/session/target-registry';

describe('TargetOwnershipRegistry', () => {
  test('tracks target ownership by session and worker', () => {
    const registry = new TargetOwnershipRegistry();

    registry.set('target-1', { sessionId: 'session-1', workerId: 'worker-a' });

    expect(registry.has('target-1')).toBe(true);
    expect(registry.get('target-1')).toEqual({ sessionId: 'session-1', workerId: 'worker-a' });
    expect(Array.from(registry.keys())).toEqual(['target-1']);
    expect(Array.from(registry.values())).toEqual([{ sessionId: 'session-1', workerId: 'worker-a' }]);
  });

  test('overwrites ownership atomically and reports deletion', () => {
    const registry = new TargetOwnershipRegistry();
    registry.set('target-1', { sessionId: 'session-1', workerId: 'worker-a' });

    registry.set('target-1', { sessionId: 'session-2', workerId: 'worker-b' });

    expect(registry.get('target-1')).toEqual({ sessionId: 'session-2', workerId: 'worker-b' });
    expect(registry.delete('target-1')).toBe(true);
    expect(registry.delete('target-1')).toBe(false);
    expect(registry.has('target-1')).toBe(false);
  });
});
