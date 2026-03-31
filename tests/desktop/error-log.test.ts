/// <reference types="jest" />
/**
 * Unit tests for ErrorLogBuffer — in-memory ring buffer with sensitive data filtering.
 */

import { ErrorLogBuffer, LogEntry } from '../../src/desktop/error-log';

describe('ErrorLogBuffer', () => {
  describe('constructor', () => {
    test('defaults to 100 max entries', () => {
      const buf = new ErrorLogBuffer();
      expect(buf.getSize()).toBe(0);
    });

    test('accepts custom capacity', () => {
      const buf = new ErrorLogBuffer(10);
      for (let i = 0; i < 10; i++) {
        buf.append('info', 'test', `msg ${i}`);
      }
      expect(buf.getSize()).toBe(10);
    });

    test('throws RangeError for capacity < 1', () => {
      expect(() => new ErrorLogBuffer(0)).toThrow(RangeError);
    });
  });

  describe('append and retrieve', () => {
    test('appends a single entry and retrieves it', () => {
      const buf = new ErrorLogBuffer(10);
      buf.append('info', 'sidecar', 'hello world');
      const all = buf.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].level).toBe('info');
      expect(all[0].source).toBe('sidecar');
      expect(all[0].message).toBe('hello world');
    });

    test('timestamp is a recent epoch millisecond value', () => {
      const before = Date.now();
      const buf = new ErrorLogBuffer(10);
      buf.append('warn', 'tunnel', 'test');
      const after = Date.now();
      const entry = buf.getAll()[0];
      expect(entry.timestamp).toBeGreaterThanOrEqual(before);
      expect(entry.timestamp).toBeLessThanOrEqual(after);
    });

    test('entries are returned in chronological order', () => {
      const buf = new ErrorLogBuffer(10);
      buf.append('info', 'a', 'first');
      buf.append('warn', 'b', 'second');
      buf.append('error', 'c', 'third');
      const all = buf.getAll();
      expect(all[0].message).toBe('first');
      expect(all[1].message).toBe('second');
      expect(all[2].message).toBe('third');
    });
  });

  describe('ring buffer overflow', () => {
    test('drops oldest entries when capacity is exceeded', () => {
      const buf = new ErrorLogBuffer(100);
      for (let i = 0; i < 150; i++) {
        buf.append('info', 'src', `msg ${i}`);
      }
      expect(buf.getSize()).toBe(100);
      const all = buf.getAll();
      // Oldest surviving entry should be msg 50, newest msg 149
      expect(all[0].message).toBe('msg 50');
      expect(all[99].message).toBe('msg 149');
    });

    test('handles exactly capacity entries without overflow', () => {
      const buf = new ErrorLogBuffer(5);
      for (let i = 0; i < 5; i++) {
        buf.append('info', 'src', `msg ${i}`);
      }
      expect(buf.getSize()).toBe(5);
      const all = buf.getAll();
      expect(all[0].message).toBe('msg 0');
      expect(all[4].message).toBe('msg 4');
    });

    test('continues to work correctly after multiple wrap-arounds', () => {
      const buf = new ErrorLogBuffer(3);
      for (let i = 0; i < 9; i++) {
        buf.append('info', 'src', `msg ${i}`);
      }
      expect(buf.getSize()).toBe(3);
      const all = buf.getAll();
      expect(all[0].message).toBe('msg 6');
      expect(all[1].message).toBe('msg 7');
      expect(all[2].message).toBe('msg 8');
    });
  });

  describe('sensitive data redaction', () => {
    test('redacts Bearer tokens', () => {
      const buf = new ErrorLogBuffer(10);
      buf.append('info', 'sidecar', 'Auth: Bearer eyABC123.def456.ghi789');
      expect(buf.getAll()[0].message).toBe('Auth: Bearer [REDACTED]');
    });

    test('redacts JWT strings', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const buf = new ErrorLogBuffer(10);
      buf.append('error', 'tunnel', `token=${jwt}`);
      expect(buf.getAll()[0].message).not.toContain(jwt);
      expect(buf.getAll()[0].message).toContain('[REDACTED_JWT]');
    });

    test('redacts cookie values', () => {
      const buf = new ErrorLogBuffer(10);
      buf.append('info', 'chrome', 'cookie session=abc123; path=/');
      const msg = buf.getAll()[0].message;
      expect(msg).not.toContain('abc123');
      expect(msg).toContain('[REDACTED]');
    });

    test('redacts Authorization headers', () => {
      const buf = new ErrorLogBuffer(10);
      buf.append('info', 'tunnel', 'Authorization: Basic dXNlcjpwYXNz');
      const msg = buf.getAll()[0].message;
      expect(msg).not.toContain('dXNlcjpwYXNz');
      expect(msg).toContain('[REDACTED]');
    });

    test('preserves non-sensitive parts of the message', () => {
      const buf = new ErrorLogBuffer(10);
      buf.append('warn', 'sidecar', 'Connection failed on port 9222 with Bearer secretToken123');
      const msg = buf.getAll()[0].message;
      expect(msg).toContain('Connection failed on port 9222');
      expect(msg).toContain('Bearer [REDACTED]');
      expect(msg).not.toContain('secretToken123');
    });

    test('does not alter clean messages', () => {
      const buf = new ErrorLogBuffer(10);
      const clean = 'Chrome process exited with code 0';
      buf.append('info', 'chrome', clean);
      expect(buf.getAll()[0].message).toBe(clean);
    });
  });

  describe('getLatest', () => {
    test('returns last n entries in chronological order', () => {
      const buf = new ErrorLogBuffer(10);
      for (let i = 0; i < 10; i++) {
        buf.append('info', 'src', `msg ${i}`);
      }
      const latest = buf.getLatest(3);
      expect(latest).toHaveLength(3);
      expect(latest[0].message).toBe('msg 7');
      expect(latest[1].message).toBe('msg 8');
      expect(latest[2].message).toBe('msg 9');
    });

    test('returns all entries when count >= buffer size', () => {
      const buf = new ErrorLogBuffer(10);
      for (let i = 0; i < 5; i++) {
        buf.append('info', 'src', `msg ${i}`);
      }
      expect(buf.getLatest(10)).toHaveLength(5);
    });

    test('returns all entries when count is omitted', () => {
      const buf = new ErrorLogBuffer(10);
      for (let i = 0; i < 5; i++) {
        buf.append('info', 'src', `msg ${i}`);
      }
      expect(buf.getLatest()).toHaveLength(5);
    });

    test('returns empty array from empty buffer', () => {
      const buf = new ErrorLogBuffer(10);
      expect(buf.getLatest(5)).toEqual([]);
    });
  });

  describe('toClipboardText', () => {
    test('returns placeholder for empty buffer', () => {
      const buf = new ErrorLogBuffer(10);
      expect(buf.toClipboardText()).toBe('(no log entries)');
    });

    test('formats entries as ISO timestamp + level + source + message', () => {
      const buf = new ErrorLogBuffer(10);
      buf.append('error', 'sidecar', 'crash detected');
      const text = buf.toClipboardText();
      expect(text).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[ERROR\] \[sidecar\] crash detected$/);
    });

    test('produces one line per entry', () => {
      const buf = new ErrorLogBuffer(10);
      buf.append('info', 'a', 'one');
      buf.append('warn', 'b', 'two');
      buf.append('error', 'c', 'three');
      const lines = buf.toClipboardText().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('[INFO]');
      expect(lines[1]).toContain('[WARN]');
      expect(lines[2]).toContain('[ERROR]');
    });

    test('sensitive data is not present in clipboard output', () => {
      const buf = new ErrorLogBuffer(10);
      buf.append('info', 'tunnel', 'Bearer secret_token_xyz');
      const text = buf.toClipboardText();
      expect(text).not.toContain('secret_token_xyz');
      expect(text).toContain('Bearer [REDACTED]');
    });
  });

  describe('clear', () => {
    test('resets the buffer to empty', () => {
      const buf = new ErrorLogBuffer(10);
      for (let i = 0; i < 10; i++) {
        buf.append('info', 'src', `msg ${i}`);
      }
      buf.clear();
      expect(buf.getSize()).toBe(0);
      expect(buf.getAll()).toEqual([]);
    });

    test('allows new entries after clear', () => {
      const buf = new ErrorLogBuffer(5);
      for (let i = 0; i < 5; i++) {
        buf.append('info', 'src', `old ${i}`);
      }
      buf.clear();
      buf.append('warn', 'src', 'fresh start');
      expect(buf.getSize()).toBe(1);
      expect(buf.getAll()[0].message).toBe('fresh start');
    });
  });

  describe('empty buffer edge cases', () => {
    test('getAll returns empty array', () => {
      expect(new ErrorLogBuffer(10).getAll()).toEqual([]);
    });

    test('getSize returns 0', () => {
      expect(new ErrorLogBuffer(10).getSize()).toBe(0);
    });

    test('toClipboardText returns placeholder string', () => {
      expect(new ErrorLogBuffer(10).toClipboardText()).toBe('(no log entries)');
    });

    test('clear on empty buffer is a no-op', () => {
      const buf = new ErrorLogBuffer(10);
      expect(() => buf.clear()).not.toThrow();
      expect(buf.getSize()).toBe(0);
    });
  });
});
