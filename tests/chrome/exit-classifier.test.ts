import {
  classifyExit,
  antiFlapMs,
  quiesceMs,
  shouldRateLimitRelaunch,
} from '../../src/chrome/exit-classifier';

describe('classifyExit (#660)', () => {
  it('intentionalStop → intentional', () => {
    expect(classifyExit({ code: 0, signal: null, uptimeMs: 60_000, intentionalStop: true })).toBe('intentional');
  });

  it('uptime below anti-flap threshold → crash regardless of code', () => {
    expect(classifyExit({ code: 0, signal: null, uptimeMs: 1000, intentionalStop: false }, { antiFlapMs: 5000 })).toBe('crash');
    expect(classifyExit({ code: 1, signal: null, uptimeMs: 1000, intentionalStop: false }, { antiFlapMs: 5000 })).toBe('crash');
  });

  it('exit code 0 with sufficient uptime → clean', () => {
    expect(classifyExit({ code: 0, signal: null, uptimeMs: 60_000, intentionalStop: false })).toBe('clean');
  });

  it('SIGTERM (red dot / Cmd+Q on macOS) → clean', () => {
    expect(classifyExit({ code: null, signal: 'SIGTERM', uptimeMs: 60_000, intentionalStop: false })).toBe('clean');
  });

  it('SIGINT → clean', () => {
    expect(classifyExit({ code: null, signal: 'SIGINT', uptimeMs: 60_000, intentionalStop: false })).toBe('clean');
  });

  it('SIGKILL → crash', () => {
    expect(classifyExit({ code: null, signal: 'SIGKILL', uptimeMs: 60_000, intentionalStop: false })).toBe('crash');
  });

  it('SIGSEGV → crash', () => {
    expect(classifyExit({ code: null, signal: 'SIGSEGV', uptimeMs: 60_000, intentionalStop: false })).toBe('crash');
  });

  it('non-zero exit code → crash', () => {
    expect(classifyExit({ code: 137, signal: null, uptimeMs: 60_000, intentionalStop: false })).toBe('crash');
    expect(classifyExit({ code: 139, signal: null, uptimeMs: 60_000, intentionalStop: false })).toBe('crash');
  });
});

describe('antiFlapMs', () => {
  it('default is 5000ms', () => {
    expect(antiFlapMs(undefined)).toBe(5000);
    expect(antiFlapMs('')).toBe(5000);
  });

  it('parses positive integer seconds', () => {
    expect(antiFlapMs('10')).toBe(10_000);
    expect(antiFlapMs('1')).toBe(1_000);
  });

  it('falls back on invalid input', () => {
    expect(antiFlapMs('abc')).toBe(5000);
    expect(antiFlapMs('-1')).toBe(5000);
    expect(antiFlapMs('0')).toBe(5000);
  });
});

describe('quiesceMs', () => {
  it('default is 60_000ms', () => {
    expect(quiesceMs(undefined)).toBe(60_000);
    expect(quiesceMs('')).toBe(60_000);
  });

  it('parses positive integer ms', () => {
    expect(quiesceMs('30000')).toBe(30_000);
    expect(quiesceMs('120000')).toBe(120_000);
  });

  it('falls back on invalid input', () => {
    expect(quiesceMs('abc')).toBe(60_000);
    expect(quiesceMs('-1')).toBe(60_000);
  });
});

describe('shouldRateLimitRelaunch', () => {
  it('returns false when fewer than threshold crashes', () => {
    const now = 1_000_000;
    expect(shouldRateLimitRelaunch([], now)).toBe(false);
    expect(shouldRateLimitRelaunch([now - 5_000, now - 10_000], now)).toBe(false);
  });

  it('returns true when threshold crashes within window', () => {
    const now = 1_000_000;
    expect(shouldRateLimitRelaunch([now - 5_000, now - 10_000, now - 15_000], now)).toBe(true);
  });

  it('ignores crashes outside window', () => {
    const now = 1_000_000;
    expect(shouldRateLimitRelaunch([now - 70_000, now - 80_000, now - 90_000], now)).toBe(false);
  });

  it('mixed inside/outside — only counts in-window', () => {
    const now = 1_000_000;
    expect(shouldRateLimitRelaunch([now - 70_000, now - 5_000, now - 10_000, now - 15_000], now)).toBe(true);
    expect(shouldRateLimitRelaunch([now - 70_000, now - 5_000, now - 10_000], now)).toBe(false);
  });
});
