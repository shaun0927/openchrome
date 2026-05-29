import {
  getBrokerLifecycleSnapshot,
  recordBrokerReconnect,
  recordBrokerStopped,
  recordBrokerStopping,
  resetBrokerLifecycleForTest,
  setBrokerOwnerMode,
  shouldOcStopKeepChromeByDefault,
} from '../src/broker/lifecycle';

describe('broker lifecycle state', () => {
  beforeEach(() => resetBrokerLifecycleForTest());

  test('enables broker owner mode and makes oc_stop keep Chrome by default', () => {
    const state = setBrokerOwnerMode(true);

    expect(state).toMatchObject({ mode: 'owner', state: 'running', ocStopDefaultKeepChrome: true });
    expect(shouldOcStopKeepChromeByDefault()).toBe(true);
    expect(getBrokerLifecycleSnapshot().startedAt).toEqual(expect.any(String));
  });

  test('tracks reconnect and stop transitions for health diagnostics', () => {
    setBrokerOwnerMode(true);
    expect(recordBrokerReconnect('reconnecting')).toMatchObject({ state: 'reconnecting', lastEvent: 'reconnecting' });
    expect(recordBrokerReconnect('reconnected')).toMatchObject({ state: 'running', reconnectCount: 1, lastEvent: 'reconnected' });
    expect(recordBrokerStopping()).toMatchObject({ state: 'stopping', lastEvent: 'broker_owner_stopping' });
    expect(recordBrokerStopped()).toMatchObject({ state: 'stopped', lastEvent: 'broker_owner_stopped' });
  });
});
