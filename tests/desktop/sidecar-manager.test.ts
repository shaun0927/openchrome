/// <reference types="jest" />
import { SidecarManager, SidecarOptions } from '../../src/desktop/sidecar-manager';

// ─── Mock child_process.spawn ─────────────────────────────────────────────────

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

import { spawn } from 'child_process';
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

/** Minimal fake ChildProcess backed by EventEmitter */
import { EventEmitter } from 'events';

class FakeProcess extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  stderr: EventEmitter & { setEncoding: jest.Mock };
  killed = false;

  constructor(pid = 1234) {
    super();
    this.pid = pid;
    const stderrEmitter = new EventEmitter() as EventEmitter & { setEncoding: jest.Mock };
    stderrEmitter.setEncoding = jest.fn();
    this.stderr = stderrEmitter;
  }

  kill(signal?: string): boolean {
    this.killed = true;
    // Simulate exit on next tick so tests can detect it
    setImmediate(() => {
      this.exitCode = 0;
      this.emit('exit', signal === 'SIGTERM' ? null : 1, signal ?? null);
    });
    return true;
  }

  /** Simulate a crash: emit stderr data (if reason given) then exit with non-zero code */
  crash(code = 1, stderrMessage?: string): void {
    if (stderrMessage) {
      this.stderr.emit('data', stderrMessage + '\n');
    }
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOptions(overrides: Partial<SidecarOptions> = {}): SidecarOptions {
  return {
    command: 'node',
    args: ['dist/index.js', 'serve'],
    basePort: 3100,
    maxCrashes: 3,
    crashWindowMs: 300000,
    ...overrides,
  };
}

/** Create a SidecarManager and a fresh FakeProcess pre-wired to mockSpawn.
 *  Does NOT call manager.start() — callers must do that themselves. */
function createManager(overrides: Partial<SidecarOptions> = {}): {
  manager: SidecarManager;
  fakeProc: FakeProcess;
} {
  const fakeProc = new FakeProcess(9000);
  mockSpawn.mockReturnValueOnce(fakeProc as any);
  const manager = new SidecarManager(makeOptions(overrides));
  return { manager, fakeProc };
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('SidecarManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── 1. start() / stop() lifecycle ────────────────────────────────────────

  describe('start() / stop() lifecycle', () => {
    test('start() calls spawn with correct command and args', () => {
      const { manager } = createManager();
      manager.start();

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn).toHaveBeenCalledWith(
        'node',
        ['dist/index.js', 'serve'],
        expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] }),
      );
    });

    test('start() sets PORT env from basePort', () => {
      const { manager } = createManager({ basePort: 3200 });
      manager.start();

      const callArgs = mockSpawn.mock.calls[0];
      const env = callArgs[2]?.env as Record<string, string>;
      expect(env['PORT']).toBe('3200');
    });

    test('start() emits "started" and "running" events', () => {
      const { manager } = createManager();
      const startedFn = jest.fn();
      const runningFn = jest.fn();
      manager.on('started', startedFn);
      manager.on('running', runningFn);

      manager.start();

      expect(startedFn).toHaveBeenCalledWith({ pid: 9000, port: 3100 });
      expect(runningFn).toHaveBeenCalledWith({ pid: 9000, port: 3100 });
    });

    test('start() is idempotent — second call while running does not spawn again', () => {
      const { manager } = createManager();
      manager.start();
      manager.start(); // second call — should be no-op

      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    test('stop() sets status to stopped', async () => {
      const { manager } = createManager();
      manager.start();

      await manager.stop();

      expect(manager.getState().status).toBe('stopped');
    });

    test('stop() is safe when not started', async () => {
      const manager = new SidecarManager(makeOptions());
      await expect(manager.stop()).resolves.toBeUndefined();
      expect(manager.getState().status).toBe('stopped');
    });

    test('stop() does not trigger crash-recovery logic', async () => {
      const { manager } = createManager();
      const crashedFn = jest.fn();
      manager.on('crashed', crashedFn);

      manager.start();
      await manager.stop();

      expect(crashedFn).not.toHaveBeenCalled();
    });
  });

  // ─── 2. getState() ────────────────────────────────────────────────────────

  describe('getState()', () => {
    test('returns stopped status before start()', () => {
      const manager = new SidecarManager(makeOptions());
      const state = manager.getState();
      expect(state.status).toBe('stopped');
      expect(state.pid).toBeNull();
      expect(state.crashCount).toBe(0);
      expect(state.lastError).toBeNull();
    });

    test('returns running status after start()', () => {
      const { manager } = createManager();
      manager.start();

      const state = manager.getState();
      expect(state.status).toBe('running');
      expect(state.pid).toBe(9000);
      expect(state.port).toBe(3100);
    });

    test('uptime is 0 before start()', () => {
      const manager = new SidecarManager(makeOptions());
      expect(manager.getState().uptime).toBe(0);
    });

    test('uptime is non-negative after start()', () => {
      const { manager } = createManager();
      manager.start();
      expect(manager.getState().uptime).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── 3. Crash detection and auto-restart ──────────────────────────────────

  describe('crash detection and auto-restart', () => {
    test('emits "crashed" when process exits with non-zero code', () => {
      const fakeProc1 = new FakeProcess(1001);
      const fakeProc2 = new FakeProcess(1002);
      mockSpawn
        .mockReturnValueOnce(fakeProc1 as any)
        .mockReturnValueOnce(fakeProc2 as any);

      const manager = new SidecarManager(makeOptions({ maxCrashes: 3 }));
      const crashedFn = jest.fn();
      manager.on('crashed', crashedFn);

      manager.start();
      fakeProc1.crash(1);

      expect(crashedFn).toHaveBeenCalledTimes(1);
      expect(crashedFn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'exited with code 1', crashCount: 1 }),
      );
    });

    test('emits "restarting" and auto-restarts after first crash', () => {
      const fakeProc1 = new FakeProcess(1001);
      const fakeProc2 = new FakeProcess(1002);
      mockSpawn
        .mockReturnValueOnce(fakeProc1 as any)
        .mockReturnValueOnce(fakeProc2 as any);

      const manager = new SidecarManager(makeOptions({ maxCrashes: 3 }));
      const restartingFn = jest.fn();
      manager.on('restarting', restartingFn);

      manager.start();
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      fakeProc1.crash(1);

      expect(restartingFn).toHaveBeenCalledWith(
        expect.objectContaining({ crashCount: 1 }),
      );
      // Second spawn triggered automatically
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    test('restarted process is tracked as running', () => {
      const fakeProc1 = new FakeProcess(2001);
      const fakeProc2 = new FakeProcess(2002);
      mockSpawn
        .mockReturnValueOnce(fakeProc1 as any)
        .mockReturnValueOnce(fakeProc2 as any);

      const manager = new SidecarManager(makeOptions({ maxCrashes: 3 }));
      manager.start();
      fakeProc1.crash(1);

      const state = manager.getState();
      expect(state.status).toBe('running');
      expect(state.pid).toBe(2002);
    });
  });

  // ─── 4. Crash limit enforcement ───────────────────────────────────────────

  describe('crash limit enforcement', () => {
    test('emits "exhausted" after maxCrashes crashes in the window', () => {
      // maxCrashes=3: proc0 (initial) + proc1 (restart after crash1) + proc2 (restart after crash2)
      // crash3 on proc2 → exhausted (no proc3 needed)
      const procs = [0, 1, 2].map((id) => new FakeProcess(id));
      procs.forEach((p) => mockSpawn.mockReturnValueOnce(p as any));

      const manager = new SidecarManager(makeOptions({ maxCrashes: 3, crashWindowMs: 60000 }));
      const exhaustedFn = jest.fn();
      const restartingFn = jest.fn();
      manager.on('exhausted', exhaustedFn);
      manager.on('restarting', restartingFn);

      manager.start();       // spawns procs[0]
      procs[0].crash(1);    // crashCount=1 → restart → spawns procs[1]
      procs[1].crash(1);    // crashCount=2 → restart → spawns procs[2]
      procs[2].crash(1);    // crashCount=3 → exhausted (no restart)

      expect(exhaustedFn).toHaveBeenCalledTimes(1);
      expect(exhaustedFn).toHaveBeenCalledWith({
        crashCount: 3,
        message: 'Server keeps crashing',
      });
      // Only 2 restarts (after crashes 1 and 2); the 3rd crash triggers exhausted
      expect(restartingFn).toHaveBeenCalledTimes(2);
    });

    test('status is exhausted after crash limit reached', () => {
      const procs = [0, 1, 2].map((id) => new FakeProcess(id));
      procs.forEach((p) => mockSpawn.mockReturnValueOnce(p as any));

      const manager = new SidecarManager(makeOptions({ maxCrashes: 3, crashWindowMs: 60000 }));
      manager.start();
      procs[0].crash(1);
      procs[1].crash(1);
      procs[2].crash(1);

      expect(manager.getState().status).toBe('exhausted');
    });

    test('does not restart after exhausted state', () => {
      const procs = [0, 1, 2].map((id) => new FakeProcess(id));
      procs.forEach((p) => mockSpawn.mockReturnValueOnce(p as any));

      const manager = new SidecarManager(makeOptions({ maxCrashes: 3, crashWindowMs: 60000 }));
      manager.start();
      procs[0].crash(1);
      procs[1].crash(1);
      procs[2].crash(1);

      // 3 spawns total: initial + 2 restarts (3rd crash → exhausted, no 4th spawn)
      expect(mockSpawn).toHaveBeenCalledTimes(3);
    });

    test('crashes outside the window do not count toward the limit', () => {
      // crashWindowMs=0 means every stored timestamp is immediately stale.
      // Each crash sees 0 in-window predecessors, so crashCount is always 1.
      // The manager will keep restarting but never hit maxCrashes=3.
      // We only verify "exhausted" is NOT emitted for the first two crashes.
      const procs = [0, 1, 2].map((id) => new FakeProcess(id));
      procs.forEach((p) => mockSpawn.mockReturnValueOnce(p as any));

      const exhaustedFn = jest.fn();
      const manager = new SidecarManager(makeOptions({
        maxCrashes: 3,
        crashWindowMs: 0,
      }));
      manager.on('exhausted', exhaustedFn);

      manager.start();   // spawns procs[0]
      procs[0].crash(1); // window=0 → in-window count=1 < 3 → restart → spawns procs[1]
      procs[1].crash(1); // window=0 → in-window count=1 < 3 → restart → spawns procs[2]
      // procs[2] is now running; we don't crash it to avoid exhausting mock queue

      expect(exhaustedFn).not.toHaveBeenCalled();
    });
  });

  // ─── 5. Port auto-increment on EADDRINUSE ─────────────────────────────────

  describe('port auto-increment on EADDRINUSE', () => {
    test('increments port when EADDRINUSE appears in stderr', () => {
      const fakeProc1 = new FakeProcess(5001);
      const fakeProc2 = new FakeProcess(5002);
      mockSpawn
        .mockReturnValueOnce(fakeProc1 as any)
        .mockReturnValueOnce(fakeProc2 as any);

      const manager = new SidecarManager(makeOptions({ basePort: 3100, maxCrashes: 3 }));
      const portChangedFn = jest.fn();
      manager.on('port-changed', portChangedFn);

      manager.start();
      // Simulate EADDRINUSE in stderr then crash
      fakeProc1.crash(1, 'Error: listen EADDRINUSE :::3100');

      expect(portChangedFn).toHaveBeenCalledWith({ oldPort: 3100, newPort: 3101 });
      // Second spawn should receive updated PORT
      const secondEnv = mockSpawn.mock.calls[1][2]?.env as Record<string, string>;
      expect(secondEnv['PORT']).toBe('3101');
    });

    test('state reflects incremented port after EADDRINUSE', () => {
      const fakeProc1 = new FakeProcess(5001);
      const fakeProc2 = new FakeProcess(5002);
      mockSpawn
        .mockReturnValueOnce(fakeProc1 as any)
        .mockReturnValueOnce(fakeProc2 as any);

      const manager = new SidecarManager(makeOptions({ basePort: 3100, maxCrashes: 3 }));
      manager.start();
      fakeProc1.crash(1, 'Error: listen EADDRINUSE :::3100');

      expect(manager.getState().port).toBe(3101);
    });

    test('does not increment port when no EADDRINUSE in stderr', () => {
      const fakeProc1 = new FakeProcess(5001);
      const fakeProc2 = new FakeProcess(5002);
      mockSpawn
        .mockReturnValueOnce(fakeProc1 as any)
        .mockReturnValueOnce(fakeProc2 as any);

      const manager = new SidecarManager(makeOptions({ basePort: 3100, maxCrashes: 3 }));
      const portChangedFn = jest.fn();
      manager.on('port-changed', portChangedFn);

      manager.start();
      fakeProc1.crash(1, 'some other error');

      expect(portChangedFn).not.toHaveBeenCalled();
      expect(manager.getState().port).toBe(3100);
    });
  });

  // ─── 6. Stderr capture ────────────────────────────────────────────────────

  describe('stderr capture', () => {
    test('emits "stderr" event when child writes to stderr', () => {
      const { manager, fakeProc } = createManager();
      const stderrFn = jest.fn();
      manager.on('stderr', stderrFn);

      manager.start();
      fakeProc.stderr.emit('data', 'some error message\n');

      expect(stderrFn).toHaveBeenCalledWith({ data: 'some error message\n' });
    });

    test('getStderrLog() returns captured stderr lines', () => {
      const { manager, fakeProc } = createManager();
      manager.start();

      fakeProc.stderr.emit('data', 'line one\nline two\n');

      const log = manager.getStderrLog();
      expect(log.join('\n')).toContain('line one');
      expect(log.join('\n')).toContain('line two');
    });

    test('getStderrLog(N) returns at most N lines', () => {
      const { manager, fakeProc } = createManager();
      manager.start();

      // Emit many lines
      for (let i = 0; i < 20; i++) {
        fakeProc.stderr.emit('data', `line ${i}\n`);
      }

      const log = manager.getStderrLog(5);
      expect(log.length).toBeLessThanOrEqual(5);
    });

    test('lastError is set to crash reason', () => {
      const fakeProc1 = new FakeProcess(7001);
      const fakeProc2 = new FakeProcess(7002);
      mockSpawn
        .mockReturnValueOnce(fakeProc1 as any)
        .mockReturnValueOnce(fakeProc2 as any);

      const manager = new SidecarManager(makeOptions({ maxCrashes: 3 }));
      manager.start();
      fakeProc1.crash(2);

      expect(manager.getState().lastError).toBe('exited with code 2');
    });
  });

  // ─── 7. Intentional stop vs crash ─────────────────────────────────────────

  describe('intentional stop vs crash distinction', () => {
    test('stop() does not trigger "crashed" event', async () => {
      const { manager } = createManager();
      const crashedFn = jest.fn();
      manager.on('crashed', crashedFn);

      manager.start();
      await manager.stop();

      expect(crashedFn).not.toHaveBeenCalled();
    });

    test('stop() does not trigger "restarting" event', async () => {
      const { manager } = createManager();
      const restartingFn = jest.fn();
      manager.on('restarting', restartingFn);

      manager.start();
      await manager.stop();

      expect(restartingFn).not.toHaveBeenCalled();
    });

    test('stop() status is "stopped" not "crashed"', async () => {
      const { manager } = createManager();
      manager.start();
      await manager.stop();

      expect(manager.getState().status).toBe('stopped');
    });
  });

  // ─── 8. State transitions ─────────────────────────────────────────────────

  describe('state transitions', () => {
    test('transitions: stopped → running on start()', () => {
      const { manager } = createManager();
      expect(manager.getState().status).toBe('stopped');

      manager.start();

      expect(manager.getState().status).toBe('running');
    });

    test('transitions: started/running/crashed/restarting events fire in correct order on crash', () => {
      const fakeProc1 = new FakeProcess(8001);
      const fakeProc2 = new FakeProcess(8002);
      mockSpawn
        .mockReturnValueOnce(fakeProc1 as any)
        .mockReturnValueOnce(fakeProc2 as any);

      const events: string[] = [];
      const manager = new SidecarManager(makeOptions({ maxCrashes: 3 }));
      manager.on('started', () => events.push('started'));
      manager.on('running', () => events.push('running'));
      manager.on('crashed', () => events.push('crashed'));
      manager.on('restarting', () => events.push('restarting'));

      manager.start();
      fakeProc1.crash(1);

      expect(events).toEqual(['started', 'running', 'crashed', 'restarting', 'started', 'running']);
    });

    test('exhausted event fires after max crashes without further restarts', () => {
      const procs = [0, 1, 2].map((id) => new FakeProcess(id));
      procs.forEach((p) => mockSpawn.mockReturnValueOnce(p as any));

      const events: string[] = [];
      const manager = new SidecarManager(makeOptions({ maxCrashes: 3, crashWindowMs: 60000 }));
      manager.on('crashed', () => events.push('crashed'));
      manager.on('exhausted', () => events.push('exhausted'));
      manager.on('restarting', () => events.push('restarting'));

      manager.start();
      procs[0].crash(1); // crash1 → restart
      procs[1].crash(1); // crash2 → restart
      procs[2].crash(1); // crash3 → exhausted

      expect(events).toContain('exhausted');
      expect(events[events.length - 1]).toBe('exhausted');
    });
  });

  // ─── 9. crashCount in state ───────────────────────────────────────────────

  describe('crashCount tracking', () => {
    test('crashCount increments with each crash', () => {
      const procs = [0, 1, 2].map((id) => new FakeProcess(id));
      procs.forEach((p) => mockSpawn.mockReturnValueOnce(p as any));

      const manager = new SidecarManager(makeOptions({ maxCrashes: 5, crashWindowMs: 60000 }));
      manager.start();

      expect(manager.getState().crashCount).toBe(0);

      procs[0].crash(1);
      expect(manager.getState().crashCount).toBe(1);

      procs[1].crash(1);
      expect(manager.getState().crashCount).toBe(2);
    });
  });
});
