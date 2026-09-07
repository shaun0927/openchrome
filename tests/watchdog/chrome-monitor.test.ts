import { ChromeProcessMonitor, monitorChromeConnection } from '../../src/watchdog/chrome-monitor';
import { readProcessMemory, ProcessMemorySample } from '../../src/core/process/memory';

jest.mock('../../src/core/process/memory', () => ({ readProcessMemory: jest.fn() }));
const read = readProcessMemory as jest.MockedFunction<typeof readProcessMemory>;
const sample = (bytes = 1024, identity = '12:first'): ProcessMemorySample => ({
  pid: 12, identity, residentBytes: bytes, timestamp: Date.now(), processCount: 3,
  processIds: [12, 13, 14], scope: 'process-tree', metric: 'working-set',
});
async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe('ChromeProcessMonitor', () => {
  let monitor: ChromeProcessMonitor;
  beforeEach(() => {
    jest.useFakeTimers(); read.mockReset(); read.mockResolvedValue(sample());
    monitor = new ChromeProcessMonitor({ intervalMs: 1000, warnBytes: 2000, criticalBytes: 4000 });
  });
  afterEach(() => { monitor.stop(); jest.useRealTimers(); });
  test('samples descendants on all platforms and schedules follow-up', async () => {
    expect(monitor.getStats()).toBeNull(); monitor.start(12); await flush();
    expect(read).toHaveBeenCalledWith(12, true, expect.any(AbortSignal));
    expect(monitor.getStats()).toMatchObject({ pid: 12, rssBytes: 1024, processCount: 3, scope: 'process-tree' });
    jest.advanceTimersByTime(1000); await flush(); expect(read).toHaveBeenCalledTimes(2);
  });
  test.each([[1000, 0, 0], [2000, 0, 0], [3000, 1, 0], [4000, 1, 0], [5000, 0, 1]])(
    'pressure events for %i bytes', async (bytes, warnings, criticals) => {
      read.mockResolvedValue(sample(bytes)); const warn = jest.fn(); const critical = jest.fn();
      monitor.on('warn', warn); monitor.on('critical', critical); monitor.start(12); await flush();
      expect(warn).toHaveBeenCalledTimes(warnings); expect(critical).toHaveBeenCalledTimes(criticals);
    },
  );
  test('collection failure clears previous data and is observable', async () => {
    const unavailable = jest.fn(); monitor.on('unavailable', unavailable); monitor.start(12); await flush();
    read.mockRejectedValueOnce(new Error('collector unavailable')); jest.advanceTimersByTime(1000); await flush();
    expect(monitor.getStats()).toBeNull();
    expect(unavailable).toHaveBeenCalledWith({ pid: 12, reason: 'collector unavailable' });
  });
  test('PID reuse cannot silently replace measured browser', async () => {
    monitor.start(12); await flush(); read.mockResolvedValue(sample(1000, '12:second'));
    jest.advanceTimersByTime(1000); await flush(); expect(monitor.getStats()).toBeNull();
  });
  test('stop suppresses late callbacks and pressure events', async () => {
    let resolve!: (value: ProcessMemorySample) => void;
    read.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const critical = jest.fn(); monitor.on('critical', critical);
    monitor.start(12); monitor.stop(); resolve(sample(5000)); await flush(); jest.advanceTimersByTime(5000);
    expect(monitor.getStats()).toBeNull(); expect(critical).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1);
  });
  test('slow collection cannot create overlapping collectors', () => {
    read.mockReturnValueOnce(new Promise(() => undefined)); monitor.start(12); jest.advanceTimersByTime(5000);
    expect(read).toHaveBeenCalledTimes(1);
  });
  test('restart ignores earlier generation', async () => {
    let resolve!: (value: ProcessMemorySample) => void;
    read.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    monitor.start(12); monitor.start(12); await flush(); resolve(sample(99999)); await flush();
    expect(monitor.getStats()?.rssBytes).toBe(1024);
  });
  test.each([0, -1, NaN, 1.5])('rejects invalid PID %s', pid => {
    expect(() => monitor.start(pid)).toThrow('Invalid Chrome process id');
  });
});


describe('lazy browser memory monitoring', () => {
  test('starts only on a managed connection and detaches on shutdown', () => {
    let pid: number | null = null;
    let event!: (event: { type: string }) => void;
    const client = {
      getChromePid: () => pid,
      addConnectionListener: (fn: typeof event) => { event = fn; },
      removeConnectionListener: jest.fn(),
    };
    const monitor = { start: jest.fn(), stop: jest.fn() };
    const dispose = monitorChromeConnection(monitor as never, client);
    expect(monitor.start).not.toHaveBeenCalled();
    pid = 12; event({ type: 'connected' });
    expect(monitor.start).toHaveBeenCalledWith(12);
    event({ type: 'connected' });
    expect(monitor.start).toHaveBeenCalledTimes(1);
    event({ type: 'disconnected' });
    expect(monitor.stop).toHaveBeenCalled();
    dispose();
    expect(client.removeConnectionListener).toHaveBeenCalledWith(event);
  });
});
