export type BrokerLifecycleMode = 'direct' | 'broker-owner' | 'broker-client';
export type BrokerReconnectState = 'idle' | 'reconnecting' | 'failed';

export interface BrokerLifecycleState {
  mode: BrokerLifecycleMode;
  reconnectState: BrokerReconnectState;
  activeLeases: number;
  lastReconnectAt?: number;
  lastDisconnectAt?: number;
  lastError?: string;
}

const state: BrokerLifecycleState = {
  mode: 'direct',
  reconnectState: 'idle',
  activeLeases: 0,
};

export function setBrokerLifecycleMode(mode: BrokerLifecycleMode): void {
  state.mode = mode;
}

export function markBrokerReconnectStart(now = Date.now()): void {
  state.reconnectState = 'reconnecting';
  state.lastDisconnectAt = now;
  delete state.lastError;
}

export function markBrokerReconnectSuccess(now = Date.now()): void {
  state.reconnectState = 'idle';
  state.lastReconnectAt = now;
  delete state.lastError;
}

export function markBrokerReconnectFailed(error: string, now = Date.now()): void {
  state.reconnectState = 'failed';
  state.lastDisconnectAt = now;
  state.lastError = error;
}

export function setBrokerActiveLeases(count: number): void {
  state.activeLeases = Math.max(0, count);
}

export function getBrokerLifecycleState(): BrokerLifecycleState {
  return { ...state };
}

export function resetBrokerLifecycleState(): void {
  state.mode = 'direct';
  state.reconnectState = 'idle';
  state.activeLeases = 0;
  delete state.lastReconnectAt;
  delete state.lastDisconnectAt;
  delete state.lastError;
}
