import {
  getBrokerLifecycleState,
  markBrokerReconnectFailed,
  markBrokerReconnectStart,
  markBrokerReconnectSuccess,
  resetBrokerLifecycleState,
  setBrokerActiveLeases,
  setBrokerLifecycleMode,
} from '../src/broker/lifecycle';

describe('broker lifecycle state', () => {
  afterEach(() => resetBrokerLifecycleState());

  test('tracks broker mode, reconnect state, and active leases', () => {
    setBrokerLifecycleMode('broker-owner');
    setBrokerActiveLeases(2);
    markBrokerReconnectStart(10);
    expect(getBrokerLifecycleState()).toMatchObject({ mode: 'broker-owner', reconnectState: 'reconnecting', activeLeases: 2, lastDisconnectAt: 10 });

    markBrokerReconnectSuccess(20);
    expect(getBrokerLifecycleState()).toMatchObject({ reconnectState: 'idle', lastReconnectAt: 20 });

    markBrokerReconnectFailed('boom', 30);
    expect(getBrokerLifecycleState()).toMatchObject({ reconnectState: 'failed', lastError: 'boom', lastDisconnectAt: 30 });
  });
});
