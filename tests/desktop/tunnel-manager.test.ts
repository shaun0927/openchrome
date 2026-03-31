/// <reference types="jest" />
/**
 * Tests for TunnelManager — tunnel resilience with reconnect and local-only fallback.
 * Issue #524: Desktop App error handling + local fallback + CLI coexistence.
 */

import { EventEmitter } from 'events';
import { ChildProcess } from 'child_process';

// Mock child_process and fs before importing the module under test
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(),
}));

import { spawn } from 'child_process';
import * as fs from 'fs';
import { TunnelManager, TunnelStatus } from '../../src/desktop/tunnel-manager';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;

// ─── FakeProcess ─────────────────────────────────────────────────────────────

class FakeProcess extends EventEmitter {
  pid = 99999;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  killSignal: string | undefined;

  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }

  /** Emit a URL line on stderr (as cloudflared does) */
  emitUrl(url = 'https://test-abc123.trycloudflare.com'): void {
    this.stderr.emit('data', Buffer.from(`Your quick Tunnel has been created! Visit it at ${url}\n`));
  }

  /** Simulate process crash */
  crash(code = 1): void {
    this.emit('exit', code, null);
  }

  /** Simulate intentional SIGTERM */
  terminate(): void {
    this.emit('exit', null, 'SIGTERM');
  }

  /** Simulate a spawn-level error (e.g. EPERM) */
  spawnError(code: string, message: string): void {
    const err: NodeJS.ErrnoException = new Error(message);
    err.code = code;
    this.emit('error', err);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFakeProcess(): FakeProcess {
  return new FakeProcess();
}

function makeManager(overrides: Partial<{
  maxReconnectAttempts: number;
  reconnectIntervalMs: number;
  blipThresholdMs: number;
}> = {}): TunnelManager {
  return new TunnelManager({
    targetPort: 3000,
    cloudflaredPath: '/usr/local/bin/cloudflared',
    maxReconnectAttempts: overrides.maxReconnectAttempts ?? 3,
    reconnectIntervalMs: overrides.reconnectIntervalMs ?? 100,
    blipThresholdMs: overrides.blipThresholdMs ?? 10000,
  });
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  mockSpawn.mockReset();
  mockExistsSync.mockReset();
  // Default: cloudflaredPath exists
  mockExistsSync.mockReturnValue(true);
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TunnelManager', () => {

  // 1. Successful tunnel connection
  describe('successful connection', () => {
    test('parses tunnel URL from stderr and emits connected event', async () => {
      const fakeProc = makeFakeProcess();
      mockSpawn.mockReturnValueOnce(fakeProc as unknown as ChildProcess);

      const manager = makeManager();
      const connectedEvents: Array<{ tunnelUrl: string }> = [];
      manager.on('connected', (e) => connectedEvents.push(e));

      await manager.start();
      // Handlers are now registered — emit URL
      fakeProc.emitUrl('https://abc-test.trycloudflare.com');

      expect(connectedEvents).toHaveLength(1);
      expect(connectedEvents[0].tunnelUrl).toBe('https://abc-test.trycloudflare.com');
      expect(manager.getState().status).toBe('connected');
      expect(manager.getState().tunnelUrl).toBe('https://abc-test.trycloudflare.com');
    });

    test('parses tunnel URL from stdout as well', async () => {
      const fakeProc = makeFakeProcess();
      mockSpawn.mockReturnValueOnce(fakeProc as unknown as ChildProcess);

      const manager = makeManager();
      const connectedEvents: Array<{ tunnelUrl: string }> = [];
      manager.on('connected', (e) => connectedEvents.push(e));

      await manager.start();
      fakeProc.stdout.emit('data', Buffer.from('https://stdout-test.trycloudflare.com\n'));

      expect(connectedEvents).toHaveLength(1);
      expect(connectedEvents[0].tunnelUrl).toBe('https://stdout-test.trycloudflare.com');
    });

    test('status transitions: disconnected → connecting → connected', async () => {
      const fakeProc = makeFakeProcess();
      mockSpawn.mockReturnValueOnce(fakeProc as unknown as ChildProcess);

      const manager = makeManager();
      const statuses: TunnelStatus[] = [manager.getState().status];

      manager.on('status-changed', ({ newStatus }: { oldStatus: TunnelStatus; newStatus: TunnelStatus }) => {
        statuses.push(newStatus);
      });

      await manager.start();
      fakeProc.emitUrl();

      expect(statuses).toEqual(['disconnected', 'connecting', 'connected']);
    });
  });

  // 2. Connection failure → local-only
  describe('connection failure → local-only fallback', () => {
    test('transitions to local-only when cloudflared crashes before URL is parsed', async () => {
      const fakeProcs = [
        makeFakeProcess(),
        makeFakeProcess(),
        makeFakeProcess(),
        makeFakeProcess(), // one extra in case reconnect fires a 4th
      ];
      let callIdx = 0;
      mockSpawn.mockImplementation(() => fakeProcs[callIdx++] as unknown as ChildProcess);

      const manager = makeManager({ reconnectIntervalMs: 100, maxReconnectAttempts: 3 });
      const localOnlyEvents: Array<{ reason: string; guidance: string }> = [];
      manager.on('local-only', (e) => localOnlyEvents.push(e));

      await manager.start();
      // First process crashes immediately (no URL emitted)
      fakeProcs[0].crash(1);

      // Advance through reconnect attempts
      await jest.runAllTimersAsync();
      if (callIdx > 1) fakeProcs[1].crash(1);
      await jest.runAllTimersAsync();
      if (callIdx > 2) fakeProcs[2].crash(1);
      await jest.runAllTimersAsync();
      if (callIdx > 3) fakeProcs[3].crash(1);
      await jest.runAllTimersAsync();

      expect(manager.getState().status).toBe('local-only');
      expect(localOnlyEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // 3. Reconnect cycle: 3 attempts then local-only
  describe('reconnect cycle', () => {
    test('attempts maxReconnectAttempts reconnects before going local-only', async () => {
      const fakeProcs = Array.from({ length: 5 }, () => makeFakeProcess());
      let callIdx = 0;
      mockSpawn.mockImplementation(() => fakeProcs[callIdx++] as unknown as ChildProcess);

      const manager = makeManager({
        maxReconnectAttempts: 3,
        reconnectIntervalMs: 100,
        blipThresholdMs: 0,
      });

      const reconnectingEvents: Array<{ attempt: number; maxAttempts: number }> = [];
      const localOnlyEvents: Array<{ reason: string }> = [];
      manager.on('reconnecting', (e) => reconnectingEvents.push(e));
      manager.on('local-only', (e) => localOnlyEvents.push(e));

      // Start and connect first
      await manager.start();
      fakeProcs[0].emitUrl();
      expect(manager.getState().status).toBe('connected');

      // Now crash — triggers reconnect cycle
      fakeProcs[0].crash(1);
      await jest.runAllTimersAsync();

      // Attempt 1 crashes
      if (callIdx > 1) fakeProcs[1].crash(1);
      await jest.runAllTimersAsync();

      // Attempt 2 crashes
      if (callIdx > 2) fakeProcs[2].crash(1);
      await jest.runAllTimersAsync();

      // Attempt 3 crashes → local-only
      if (callIdx > 3) fakeProcs[3].crash(1);
      await jest.runAllTimersAsync();

      expect(manager.getState().status).toBe('local-only');
      expect(localOnlyEvents.length).toBeGreaterThanOrEqual(1);
    });

    test('emits reconnected event on successful reconnect', async () => {
      // Use real timers for this test — the reconnect timer callback triggers
      // an async chain (_launchTunnel → findCloudflared) that fake timers
      // cannot flush reliably.
      jest.useRealTimers();

      const fakeProcs = [makeFakeProcess(), makeFakeProcess()];
      let callIdx = 0;
      mockSpawn.mockImplementation(() => fakeProcs[callIdx++] as unknown as ChildProcess);

      const manager = makeManager({ blipThresholdMs: 0, reconnectIntervalMs: 50 });
      const reconnectedEvents: Array<{ tunnelUrl: string }> = [];
      manager.on('reconnected', (e) => reconnectedEvents.push(e));

      await manager.start();
      fakeProcs[0].emitUrl('https://first.trycloudflare.com');
      expect(manager.getState().status).toBe('connected');

      // Crash first process — triggers reconnect timer
      fakeProcs[0].crash(1);

      // Wait for reconnect timer + async _launchTunnel to complete
      await new Promise((r) => setTimeout(r, 200));

      expect(callIdx).toBe(2);

      // Second reconnect succeeds
      fakeProcs[1].emitUrl('https://second.trycloudflare.com');

      expect(reconnectedEvents).toHaveLength(1);
      expect(reconnectedEvents[0].tunnelUrl).toBe('https://second.trycloudflare.com');
      expect(manager.getState().status).toBe('connected');
    });
  });

  // 4. Blip detection
  describe('blip detection', () => {
    test('short disconnect (< blipThresholdMs) does not emit reconnecting event', async () => {
      const fakeProcs = [makeFakeProcess(), makeFakeProcess()];
      let callIdx = 0;
      mockSpawn.mockImplementation(() => fakeProcs[callIdx++] as unknown as ChildProcess);

      // blipThresholdMs = 10000, so any disconnect with no time elapsed is a blip
      const manager = makeManager({ blipThresholdMs: 10000, reconnectIntervalMs: 100 });
      const reconnectingEvents: Array<unknown> = [];
      manager.on('reconnecting', (e) => reconnectingEvents.push(e));

      await manager.start();
      fakeProcs[0].emitUrl();

      // Crash immediately (blip — no time has advanced, disconnectedAt is very recent)
      fakeProcs[0].crash(1);
      await jest.runAllTimersAsync();

      // Should reconnect transparently — no 'reconnecting' event
      expect(reconnectingEvents).toHaveLength(0);
    });

    test('long disconnect (> blipThresholdMs) emits reconnecting event', async () => {
      const fakeProcs = [makeFakeProcess(), makeFakeProcess()];
      let callIdx = 0;
      mockSpawn.mockImplementation(() => fakeProcs[callIdx++] as unknown as ChildProcess);

      // blipThresholdMs = 0 so any disconnect is NOT a blip
      const manager = makeManager({ blipThresholdMs: 0, reconnectIntervalMs: 100 });
      const reconnectingEvents: Array<unknown> = [];
      manager.on('reconnecting', (e) => reconnectingEvents.push(e));

      await manager.start();
      fakeProcs[0].emitUrl();

      fakeProcs[0].crash(1);
      await jest.runAllTimersAsync();

      expect(reconnectingEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // 5. Antivirus blocking (EPERM → 'blocked' event)
  describe('antivirus blocking', () => {
    test('EPERM spawn error emits blocked and local-only events', async () => {
      const fakeProc = makeFakeProcess();
      mockSpawn.mockReturnValueOnce(fakeProc as unknown as ChildProcess);

      const manager = makeManager();
      const blockedEvents: Array<{ reason: string; guidance: string }> = [];
      const localOnlyEvents: Array<{ reason: string; guidance: string }> = [];
      manager.on('blocked', (e) => blockedEvents.push(e));
      manager.on('local-only', (e) => localOnlyEvents.push(e));

      await manager.start();
      fakeProc.spawnError('EPERM', 'Operation not permitted');

      expect(blockedEvents).toHaveLength(1);
      expect(blockedEvents[0].guidance).toContain('antivirus');
      expect(localOnlyEvents).toHaveLength(1);
      expect(manager.getState().status).toBe('local-only');
    });

    test('EACCES spawn error also emits blocked event', async () => {
      const fakeProc = makeFakeProcess();
      mockSpawn.mockReturnValueOnce(fakeProc as unknown as ChildProcess);

      const manager = makeManager();
      const blockedEvents: Array<{ reason: string; guidance: string }> = [];
      manager.on('blocked', (e) => blockedEvents.push(e));

      await manager.start();
      fakeProc.spawnError('EACCES', 'Permission denied');

      expect(blockedEvents).toHaveLength(1);
      expect(manager.getState().status).toBe('local-only');
    });
  });

  // 6. Status transitions via 'status-changed'
  describe('status-changed events', () => {
    test('emits status-changed with oldStatus and newStatus for each transition', async () => {
      const fakeProc = makeFakeProcess();
      mockSpawn.mockReturnValueOnce(fakeProc as unknown as ChildProcess);

      const manager = makeManager();
      const changes: Array<{ oldStatus: TunnelStatus; newStatus: TunnelStatus }> = [];
      manager.on('status-changed', (e) => changes.push(e));

      await manager.start();
      fakeProc.emitUrl();

      expect(changes).toContainEqual({ oldStatus: 'disconnected', newStatus: 'connecting' });
      expect(changes).toContainEqual({ oldStatus: 'connecting', newStatus: 'connected' });
    });

    test('does not emit status-changed when status is unchanged', async () => {
      const fakeProc = makeFakeProcess();
      mockSpawn.mockReturnValueOnce(fakeProc as unknown as ChildProcess);

      const manager = makeManager();
      const changes: Array<{ oldStatus: TunnelStatus; newStatus: TunnelStatus }> = [];
      manager.on('status-changed', (e) => changes.push(e));

      await manager.start();
      // Emit URL twice — second should not trigger another status-changed for 'connected'
      fakeProc.emitUrl('https://a.trycloudflare.com');
      fakeProc.emitUrl('https://b.trycloudflare.com');

      const connectedChanges = changes.filter((c) => c.newStatus === 'connected');
      expect(connectedChanges).toHaveLength(1);
    });
  });

  // 7. retry() from local-only mode
  describe('retry() from local-only', () => {
    test('retry() is no-op when not in local-only state', async () => {
      const fakeProc = makeFakeProcess();
      mockSpawn.mockReturnValueOnce(fakeProc as unknown as ChildProcess);

      const manager = makeManager();
      await manager.start();
      fakeProc.emitUrl();

      const spawnCallsBefore = mockSpawn.mock.calls.length;
      await manager.retry();
      expect(mockSpawn.mock.calls.length).toBe(spawnCallsBefore);
    });

    test('retry() re-launches tunnel from local-only state', async () => {
      const fakeProcs = Array.from({ length: 6 }, () => makeFakeProcess());
      let callIdx = 0;
      mockSpawn.mockImplementation(() => fakeProcs[callIdx++] as unknown as ChildProcess);

      const manager = makeManager({ maxReconnectAttempts: 3, reconnectIntervalMs: 100, blipThresholdMs: 0 });

      // First connection succeeds, then crashes into local-only
      await manager.start();
      fakeProcs[0].emitUrl();

      fakeProcs[0].crash(1);
      await jest.runAllTimersAsync();
      if (callIdx > 1) fakeProcs[1].crash(1);
      await jest.runAllTimersAsync();
      if (callIdx > 2) fakeProcs[2].crash(1);
      await jest.runAllTimersAsync();
      if (callIdx > 3) fakeProcs[3].crash(1);
      await jest.runAllTimersAsync();

      expect(manager.getState().status).toBe('local-only');

      // Now retry — a fresh process should be spawned
      const connectedEvents: Array<{ tunnelUrl: string }> = [];
      manager.on('connected', (e) => connectedEvents.push(e));

      await manager.retry();
      fakeProcs[callIdx - 1].emitUrl('https://retry-success.trycloudflare.com');

      expect(manager.getState().status).toBe('connected');
      expect(connectedEvents[0].tunnelUrl).toBe('https://retry-success.trycloudflare.com');
    });
  });

  // 8. stop() does not trigger reconnect
  describe('stop() lifecycle', () => {
    test('stop() does not trigger reconnect after graceful stop', async () => {
      const fakeProc = makeFakeProcess();
      mockSpawn.mockReturnValueOnce(fakeProc as unknown as ChildProcess);

      const manager = makeManager();
      await manager.start();
      fakeProc.emitUrl();

      const spawnCallsBefore = mockSpawn.mock.calls.length;
      manager.stop();
      fakeProc.terminate(); // Simulate SIGTERM

      await jest.runAllTimersAsync();

      // No additional spawn calls after stop
      expect(mockSpawn.mock.calls.length).toBe(spawnCallsBefore);
      expect(manager.getState().status).toBe('disconnected');
    });

    test('stop() sets status to disconnected', async () => {
      const fakeProc = makeFakeProcess();
      mockSpawn.mockReturnValueOnce(fakeProc as unknown as ChildProcess);

      const manager = makeManager();
      await manager.start();
      fakeProc.emitUrl();

      manager.stop();
      expect(manager.getState().status).toBe('disconnected');
    });
  });

  // 9. findCloudflared() basic logic
  describe('findCloudflared()', () => {
    test('returns configured path when it exists', async () => {
      mockExistsSync.mockImplementation((p) => p === '/usr/local/bin/cloudflared');

      const manager = new TunnelManager({
        targetPort: 3000,
        cloudflaredPath: '/usr/local/bin/cloudflared',
      });

      const result = await manager.findCloudflared();
      expect(result).toBe('/usr/local/bin/cloudflared');
    });

    test('returns null when no binary found', async () => {
      mockExistsSync.mockReturnValue(false);

      // Mock spawn for 'which' to fail
      const whichProc = makeFakeProcess();
      mockSpawn.mockReturnValueOnce(whichProc as unknown as ChildProcess);

      const manager = new TunnelManager({ targetPort: 3000 });

      // Trigger which to fail
      const findPromise = manager.findCloudflared();
      whichProc.emit('exit', 1, null);

      const result = await findPromise;
      expect(result).toBeNull();
    });

    test('returns null when configured path does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      // Mock spawn for 'which' to fail
      const whichProc = makeFakeProcess();
      mockSpawn.mockReturnValueOnce(whichProc as unknown as ChildProcess);

      const manager = new TunnelManager({
        targetPort: 3000,
        cloudflaredPath: '/nonexistent/cloudflared',
      });

      const findPromise = manager.findCloudflared();
      whichProc.emit('exit', 1, null);

      const result = await findPromise;
      expect(result).toBeNull();
    });
  });

  // 10. Manual retry after local-only: state is reset
  describe('manual retry after local-only', () => {
    test('resets reconnectAttempt and localModeReason on retry()', async () => {
      const fakeProcs = Array.from({ length: 6 }, () => makeFakeProcess());
      let callIdx = 0;
      mockSpawn.mockImplementation(() => fakeProcs[callIdx++] as unknown as ChildProcess);

      const manager = makeManager({ maxReconnectAttempts: 3, reconnectIntervalMs: 100, blipThresholdMs: 0 });

      await manager.start();
      fakeProcs[0].crash(1);
      await jest.runAllTimersAsync();
      if (callIdx > 1) fakeProcs[1].crash(1);
      await jest.runAllTimersAsync();
      if (callIdx > 2) fakeProcs[2].crash(1);
      await jest.runAllTimersAsync();
      if (callIdx > 3) fakeProcs[3].crash(1);
      await jest.runAllTimersAsync();

      expect(manager.getState().status).toBe('local-only');
      expect(manager.getState().localModeReason).not.toBeNull();

      // Setup retry process
      await manager.retry();

      const state = manager.getState();
      expect(state.reconnectAttempt).toBe(0);
      expect(state.localModeReason).toBeNull();
      expect(state.lastError).toBeNull();
    });
  });

  // getState() immutability
  describe('getState()', () => {
    test('returns a copy of state, not the internal reference', async () => {
      const fakeProc = makeFakeProcess();
      mockSpawn.mockReturnValueOnce(fakeProc as unknown as ChildProcess);

      const manager = makeManager();
      await manager.start();
      fakeProc.emitUrl();

      const state1 = manager.getState();
      const state2 = manager.getState();
      expect(state1).not.toBe(state2);
      expect(state1).toEqual(state2);
    });
  });
});
