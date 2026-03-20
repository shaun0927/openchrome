/// <reference types="jest" />

// Mock puppeteer-core
jest.mock('puppeteer-core', () => ({
  default: { connect: jest.fn() },
}));

const mockEnsureChrome = jest.fn();
jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({ ensureChrome: mockEnsureChrome }),
}));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false }),
}));

import { CDPClient } from '../../src/cdp/client';

function createClient(opts: Record<string, unknown> = {}): CDPClient {
  return new CDPClient({ port: 9222, ...opts });
}

describe('CDPClient — Adaptive Heartbeat', () => {
  test('default heartbeat mode is active', () => {
    const client = createClient();
    expect(client.getHeartbeatMode()).toBe('active');
  });

  test('setHeartbeatMode changes mode', () => {
    const client = createClient();
    client.setHeartbeatMode('idle');
    expect(client.getHeartbeatMode()).toBe('idle');
    client.setHeartbeatMode('heavy');
    expect(client.getHeartbeatMode()).toBe('heavy');
  });

  test('setHeartbeatMode is idempotent — same mode does nothing', () => {
    const client = createClient();
    // Spy to ensure startHeartbeat is not called when mode doesn't change
    const spy = jest.spyOn(client as any, 'startHeartbeat');
    client.setHeartbeatMode('active'); // already active
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('recordCommandActivity switches from idle to active', () => {
    const client = createClient();
    client.setHeartbeatMode('idle');
    expect(client.getHeartbeatMode()).toBe('idle');

    client.recordCommandActivity();
    expect(client.getHeartbeatMode()).toBe('active');
  });

  test('recordCommandActivity does not change non-idle modes', () => {
    const client = createClient();
    client.setHeartbeatMode('heavy');
    client.recordCommandActivity();
    expect(client.getHeartbeatMode()).toBe('heavy');
  });

  test('getEffectiveHeartbeatInterval returns correct intervals', () => {
    const client = createClient({ heartbeatIntervalMs: 5000 });

    // Active: base interval
    (client as any).heartbeatMode = 'active';
    expect((client as any).getEffectiveHeartbeatInterval()).toBe(5000);

    // Idle: 3x base or 15s min
    (client as any).heartbeatMode = 'idle';
    expect((client as any).getEffectiveHeartbeatInterval()).toBe(15000);

    // Heavy: half base or 2s min
    (client as any).heartbeatMode = 'heavy';
    expect((client as any).getEffectiveHeartbeatInterval()).toBe(2500);

    // Recovery: always 1s
    (client as any).heartbeatMode = 'recovery';
    expect((client as any).getEffectiveHeartbeatInterval()).toBe(1000);
  });

  test('getConnectionMetrics returns structured metrics', () => {
    const client = createClient();
    const metrics = client.getConnectionMetrics();

    expect(metrics).toHaveProperty('uptime');
    expect(metrics).toHaveProperty('reconnectCount');
    expect(metrics).toHaveProperty('avgPingLatencyMs');
    expect(metrics).toHaveProperty('heartbeatMode');
    expect(metrics).toHaveProperty('consecutiveSuccesses');
    expect(metrics).toHaveProperty('lastVerifiedAt');
    expect(metrics.reconnectCount).toBe(0);
    expect(metrics.heartbeatMode).toBe('active');
  });

  test('recovery mode auto-transitions to active after timeout', async () => {
    jest.useFakeTimers();
    const client = createClient();

    client.setHeartbeatMode('recovery');
    expect(client.getHeartbeatMode()).toBe('recovery');

    // Advance 30 seconds
    jest.advanceTimersByTime(30000);

    expect(client.getHeartbeatMode()).toBe('active');

    jest.useRealTimers();
  });

  test('heavy mode interval has 2s minimum', () => {
    // With very small base interval
    const client = createClient({ heartbeatIntervalMs: 1000 });
    (client as any).heartbeatMode = 'heavy';
    expect((client as any).getEffectiveHeartbeatInterval()).toBe(2000); // min 2000, not 500
  });
});
