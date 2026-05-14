/**
 * Tests for the structured-logging wrapper (#870).
 *
 * Validates the contract implemented in `src/utils/log.ts`:
 *  - Default level `info`; debug events dropped, info/warning/error pass.
 *  - `setLogLevel("error")` filters out info/warning/debug.
 *  - Invalid `setLogLevel` input is rejected and returns an MCP error.
 *  - Sender unwiring causes events to fall back to stderr (still mirrored
 *    automatically for `error`).
 *  - The envelope sent to the MCP transport matches MCP spec
 *    (`{ level, logger, data: { message, data? } }`).
 *  - Sender exceptions are isolated — they do not propagate to callers.
 */

import {
  log,
  setLogSender,
  setLogLevel,
  getLogLevel,
  logLevelSetErrorOrNull,
  type LogSender,
} from '../../src/utils/log';

type Captured = { level: string; logger: string; data: Record<string, unknown> };

function withCapture(fn: (events: Captured[]) => void | Promise<void>): void {
  const events: Captured[] = [];
  const sender: LogSender = (level, logger, data) => {
    events.push({ level, logger, data });
  };
  const originalLevel = getLogLevel();
  setLogSender(sender);
  try {
    Promise.resolve(fn(events)).catch(() => undefined);
  } finally {
    setLogSender(null);
    setLogLevel(originalLevel);
  }
}

describe('structured logging (#870)', () => {
  beforeEach(() => {
    setLogSender(null);
    setLogLevel('info');
  });

  test('default level is info — debug dropped, info/warning/error pass', () => {
    withCapture((events) => {
      log.debug('test', 'should be dropped');
      log.info('test', 'should pass');
      log.warning('test', 'should pass');
      log.error('test', 'should pass');
      expect(events.map((e) => e.level)).toEqual(['info', 'warning', 'error']);
    });
  });

  test('setLogLevel("error") filters out info/warning/debug', () => {
    setLogLevel('error');
    withCapture((events) => {
      log.debug('test', 'no');
      log.info('test', 'no');
      log.warning('test', 'no');
      log.error('test', 'yes');
      expect(events).toHaveLength(1);
      expect(events[0].level).toBe('error');
    });
  });

  test('setLogLevel("debug") lets every event through', () => {
    setLogLevel('debug');
    withCapture((events) => {
      log.debug('test', 'yes');
      log.info('test', 'yes');
      expect(events.map((e) => e.level)).toEqual(['debug', 'info']);
    });
  });

  test('logLevelSetErrorOrNull rejects non-string and unknown levels', () => {
    expect(logLevelSetErrorOrNull(undefined)).toMatchObject({ code: -32602 });
    expect(logLevelSetErrorOrNull(7)).toMatchObject({ code: -32602 });
    expect(logLevelSetErrorOrNull('verbose')).toMatchObject({ code: -32602 });
    expect(logLevelSetErrorOrNull('warning')).toBeNull();
    expect(logLevelSetErrorOrNull('error')).toBeNull();
    expect(logLevelSetErrorOrNull('info')).toBeNull();
    expect(logLevelSetErrorOrNull('debug')).toBeNull();
  });

  test('envelope shape — { message, data? } under MCP spec', () => {
    withCapture((events) => {
      log.warning('captcha', 'detected', { kind: 'turnstile' });
      expect(events[0]).toEqual({
        level: 'warning',
        logger: 'captcha',
        data: { message: 'detected', data: { kind: 'turnstile' } },
      });
    });
  });

  test('omits `data` field when caller does not pass one', () => {
    withCapture((events) => {
      log.info('test', 'no payload');
      expect(events[0].data).toEqual({ message: 'no payload' });
    });
  });

  test('without a sender wired, error level still mirrors to stderr', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      setLogSender(null);
      log.error('boot', 'no transport yet');
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no transport yet'));
    } finally {
      errSpy.mockRestore();
    }
  });

  test('sender exceptions are isolated — callers do not see them', () => {
    const throwingSender: LogSender = () => {
      throw new Error('transport wedged');
    };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      setLogSender(throwingSender);
      expect(() => log.info('test', 'should not throw')).not.toThrow();
      // Best-effort stderr trace from the wrapper.
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('log'), expect.any(Error));
    } finally {
      setLogSender(null);
      errSpy.mockRestore();
    }
  });
});
