/**
 * Error Log Ring Buffer — in-memory log storage for the desktop app sidecar.
 *
 * Stores the last N log entries (default 100) and strips sensitive data before
 * storage so logs can safely be copied to clipboard for bug reports.
 *
 * Sensitive patterns redacted:
 *   - Bearer tokens
 *   - JWT strings
 *   - Cookie values
 *   - Authorization headers
 */

export interface LogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  source: string; // e.g. 'sidecar', 'tunnel', 'chrome'
  message: string;
}

// Patterns that must be redacted before storing a log message.
const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._-]+/g;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const COOKIE_VALUE = /(\bcookie\b[^=\n]*=\s*)([^;\n]+)/gi;
const AUTH_HEADER = /(Authorization:\s*).*/gi;

/**
 * Strip sensitive information from a log message before it enters the buffer.
 */
function redact(message: string): string {
  return message
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(COOKIE_VALUE, '$1[REDACTED]')
    .replace(AUTH_HEADER, '$1[REDACTED]');
}

export class ErrorLogBuffer {
  private readonly maxEntries: number;
  private buffer: LogEntry[];
  private head: number; // index of the oldest entry (write position)
  private count: number; // number of valid entries currently in the buffer

  constructor(maxEntries: number = 100) {
    if (maxEntries < 1) {
      throw new RangeError('maxEntries must be at least 1');
    }
    this.maxEntries = maxEntries;
    this.buffer = new Array<LogEntry>(maxEntries);
    this.head = 0;
    this.count = 0;
  }

  /**
   * Append a new log entry. When the buffer is full the oldest entry is
   * overwritten (ring buffer behaviour).
   */
  append(level: LogEntry['level'], source: string, message: string): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      source,
      message: redact(message),
    };

    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.maxEntries;

    if (this.count < this.maxEntries) {
      this.count++;
    }
  }

  /**
   * Return all entries in chronological order (oldest first).
   */
  getAll(): LogEntry[] {
    if (this.count === 0) {
      return [];
    }

    if (this.count < this.maxEntries) {
      // Buffer is not yet full; entries start at index 0.
      return this.buffer.slice(0, this.count);
    }

    // Buffer is full; oldest entry is at this.head.
    const tail = this.buffer.slice(this.head);
    const wrappedHead = this.buffer.slice(0, this.head);
    return [...tail, ...wrappedHead];
  }

  /**
   * Return the last `count` entries in chronological order (oldest first).
   * Defaults to all entries when count is omitted.
   */
  getLatest(count?: number): LogEntry[] {
    const all = this.getAll();
    if (count === undefined || count >= all.length) {
      return all;
    }
    return all.slice(all.length - count);
  }

  /**
   * Remove all entries from the buffer.
   */
  clear(): void {
    this.buffer = new Array<LogEntry>(this.maxEntries);
    this.head = 0;
    this.count = 0;
  }

  /**
   * Format the buffer contents as a multi-line string suitable for
   * copying to the clipboard when filing a bug report.
   */
  toClipboardText(): string {
    const entries = this.getAll();
    if (entries.length === 0) {
      return '(no log entries)';
    }

    return entries
      .map((e) => {
        const ts = new Date(e.timestamp).toISOString();
        return `[${ts}] [${e.level.toUpperCase()}] [${e.source}] ${e.message}`;
      })
      .join('\n');
  }

  /**
   * Return the number of entries currently stored in the buffer.
   */
  getSize(): number {
    return this.count;
  }
}
