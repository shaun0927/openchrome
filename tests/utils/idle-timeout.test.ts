/// <reference types="jest" />
import {
  installIdleTimeout,
  parseDuration,
  formatDuration,
} from '../../src/utils/idle-timeout';
import { createIdleState } from '../../src/utils/idle-state';

describe('parseDuration', () => {
  test('accepts standard unit suffixes', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('90s')).toBe(90 * 1_000);
    expect(parseDuration('2h')).toBe(2 * 3_600_000);
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('1ms')).toBe(1);
  });

  test('rejects bare numbers — acceptance criterion 12', () => {
    expect(() => parseDuration('30')).toThrow(/invalid duration/);
    expect(() => parseDuration('0')).toThrow(/invalid duration/);
    expect(() => parseDuration('1500')).toThrow(/invalid duration/);
  });

  test('rejects nonsense and unknown units', () => {
    expect(() => parseDuration('garbage')).toThrow(/invalid duration/);
    expect(() => parseDuration('30x')).toThrow(/invalid duration/);
    expect(() => parseDuration('')).toThrow(/invalid duration/);
    expect(() => parseDuration('   ')).toThrow(/invalid duration/);
    expect(() => parseDuration('m30')).toThrow(/invalid duration/);
    // Negative numbers fall out of the regex (no `-` allowed).
    expect(() => parseDuration('-30s')).toThrow(/invalid duration/);
  });

  test('tolerates whitespace around the value', () => {
    expect(parseDuration('  10s  ')).toBe(10_000);
  });

  test('supports fractional values', () => {
    expect(parseDuration('0.5s')).toBe(500);
    expect(parseDuration('1.5m')).toBe(90_000);
  });

  test('rejects zero after multiplication', () => {
    expect(() => parseDuration('0ms')).toThrow(/positive finite/);
  });
});

describe('formatDuration', () => {
  test('picks the largest whole unit', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(2 * 3_600_000)).toBe('2h');
    expect(formatDuration(30 * 60_000)).toBe('30m');
    expect(formatDuration(90_000)).toBe('90s');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(3_000)).toBe('3s');
  });
});

describe('installIdleTimeout', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('calls exitFn exactly once when idle and sessionCount=0', () => {
    let clock = 1_000_000;
    const idle = createIdleState({ now: () => clock });
    // Fresh state reports isIdle(anyWindow)=true
    const exitFn = jest.fn();
    const logger = jest.fn();

    const handle = installIdleTimeout({
      windowMs: 1_000,
      idleState: idle,
      sessionCountFn: () => 0,
      exitFn,
      logger,
    });

    // Tick interval is min(1000/4, 60_000) = 250ms.
    jest.advanceTimersByTime(250);
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
    // Never fires twice even if more ticks would have fired.
    jest.advanceTimersByTime(5_000);
    expect(exitFn).toHaveBeenCalledTimes(1);

    expect(logger.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('idle for'))).toBe(true);

    handle.stop();
  });

  test('never calls exitFn while sessionCount > 0', () => {
    const idle = createIdleState({ now: () => 0 });
    const exitFn = jest.fn();

    const handle = installIdleTimeout({
      windowMs: 1_000,
      idleState: idle,
      sessionCountFn: () => 3,
      exitFn,
    });

    jest.advanceTimersByTime(10_000);
    expect(exitFn).not.toHaveBeenCalled();

    handle.stop();
  });

  test('never calls exitFn while not idle', () => {
    let clock = 1_000_000;
    const idle = createIdleState({ now: () => clock });
    const exitFn = jest.fn();

    idle.notifyActive(); // fresh activity → not idle for windowMs
    const handle = installIdleTimeout({
      windowMs: 10_000,
      idleState: idle,
      sessionCountFn: () => 0,
      exitFn,
    });

    // Advance past two tick intervals but stay within the 10s window.
    clock += 5_000;
    jest.advanceTimersByTime(5_000);
    expect(exitFn).not.toHaveBeenCalled();

    handle.stop();
  });

  test('handle.stop() prevents any further exit call', () => {
    const idle = createIdleState({ now: () => 0 });
    const exitFn = jest.fn();

    const handle = installIdleTimeout({
      windowMs: 1_000,
      idleState: idle,
      sessionCountFn: () => 0,
      exitFn,
    });

    handle.stop();
    jest.advanceTimersByTime(60_000);
    expect(exitFn).not.toHaveBeenCalled();
  });

  test('ticks at min(windowMs/4, 60s) — 30m window caps at 60s', () => {
    const idle = createIdleState({ now: () => 0 });
    // Use live session count so the tick short-circuits before firing exit;
    // we only care that the timer was scheduled at the right delay.
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    const handle = installIdleTimeout({
      windowMs: 30 * 60_000, // 30 minutes
      idleState: idle,
      sessionCountFn: () => 1, // never exit
      exitFn: () => {},
    });

    // First scheduleNext must use 60_000 (the cap), not 30*60_000/4.
    const firstCallDelay = setTimeoutSpy.mock.calls[0]?.[1];
    expect(firstCallDelay).toBe(60_000);

    handle.stop();
    setTimeoutSpy.mockRestore();
  });
});
