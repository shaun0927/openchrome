export type BrokerLifecycleMode = 'disabled' | 'owner';
export type BrokerLifecycleState = 'idle' | 'running' | 'reconnecting' | 'stopping' | 'stopped';

export interface BrokerLifecycleSnapshot {
  mode: BrokerLifecycleMode;
  state: BrokerLifecycleState;
  startedAt: string | null;
  updatedAt: string | null;
  reconnectCount: number;
  lastEvent: string | null;
  ocStopDefaultKeepChrome: boolean;
}

const lifecycle: BrokerLifecycleSnapshot = {
  mode: 'disabled',
  state: 'idle',
  startedAt: null,
  updatedAt: null,
  reconnectCount: 0,
  lastEvent: null,
  ocStopDefaultKeepChrome: false,
};

function nowIso(): string {
  return new Date().toISOString();
}

export function setBrokerOwnerMode(enabled: boolean): BrokerLifecycleSnapshot {
  const now = nowIso();
  lifecycle.mode = enabled ? 'owner' : 'disabled';
  lifecycle.state = enabled ? 'running' : 'idle';
  lifecycle.startedAt = enabled ? lifecycle.startedAt ?? now : null;
  lifecycle.updatedAt = now;
  lifecycle.lastEvent = enabled ? 'broker_owner_started' : 'broker_owner_disabled';
  lifecycle.ocStopDefaultKeepChrome = enabled;
  return getBrokerLifecycleSnapshot();
}

export function recordBrokerReconnect(event: 'reconnecting' | 'reconnected' | 'reconnect_failed'): BrokerLifecycleSnapshot {
  lifecycle.updatedAt = nowIso();
  lifecycle.lastEvent = event;
  if (event === 'reconnecting') {
    lifecycle.state = 'reconnecting';
  } else if (event === 'reconnected') {
    lifecycle.state = lifecycle.mode === 'owner' ? 'running' : 'idle';
    lifecycle.reconnectCount += 1;
  } else {
    lifecycle.state = 'reconnecting';
  }
  return getBrokerLifecycleSnapshot();
}

export function recordBrokerStopping(): BrokerLifecycleSnapshot {
  lifecycle.updatedAt = nowIso();
  lifecycle.state = 'stopping';
  lifecycle.lastEvent = 'broker_owner_stopping';
  return getBrokerLifecycleSnapshot();
}

export function recordBrokerStopped(): BrokerLifecycleSnapshot {
  lifecycle.updatedAt = nowIso();
  lifecycle.state = 'stopped';
  lifecycle.lastEvent = 'broker_owner_stopped';
  return getBrokerLifecycleSnapshot();
}

export function shouldOcStopKeepChromeByDefault(): boolean {
  return lifecycle.ocStopDefaultKeepChrome;
}

export function getBrokerLifecycleSnapshot(): BrokerLifecycleSnapshot {
  return { ...lifecycle };
}

export function resetBrokerLifecycleForTest(): void {
  lifecycle.mode = 'disabled';
  lifecycle.state = 'idle';
  lifecycle.startedAt = null;
  lifecycle.updatedAt = null;
  lifecycle.reconnectCount = 0;
  lifecycle.lastEvent = null;
  lifecycle.ocStopDefaultKeepChrome = false;
}
