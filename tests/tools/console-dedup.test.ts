/// <reference types="jest" />
/**
 * Unit tests for console log deduplication logic (Strategy 4).
 *
 * The `deduplicateLogs` function in src/tools/console-capture.ts is not
 * exported, so we recreate the exact algorithm here and test it in
 * isolation. The implementation mirrors lines 55-115 of console-capture.ts.
 */

// ---- Types (mirrors console-capture.ts) ----

interface ConsoleLogEntry {
  type: string;
  text: string;
  timestamp: number;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
  args?: string[];
}

interface DedupedLogEntry {
  type: string;
  text: string;
  count: number;
  firstTimestamp?: number;
  lastTimestamp?: number;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
  args?: string[];
}

// ---- Algorithm (mirrors src/tools/console-capture.ts:55-115) ----

function deduplicateLogs(logs: ConsoleLogEntry[]): DedupedLogEntry[] {
  const result: DedupedLogEntry[] = [];
  let i = 0;
  while (i < logs.length) {
    const current = logs[i];

    // NEVER deduplicate error or warning types — always show individually
    if (current.type === 'error' || current.type === 'warning') {
      result.push({
        type: current.type,
        text: current.text,
        count: 1,
        firstTimestamp: current.timestamp,
        lastTimestamp: current.timestamp,
        location: current.location,
        args: current.args,
      });
      i++;
      continue;
    }

    // Count consecutive identical messages (same text AND same type)
    let count = 1;
    while (
      i + count < logs.length &&
      logs[i + count].text === current.text &&
      logs[i + count].type === current.type
    ) {
      count++;
    }

    if (count >= 3) {
      // Collapse into single entry with count
      result.push({
        text: current.text,
        type: current.type,
        count,
        firstTimestamp: current.timestamp,
        lastTimestamp: logs[i + count - 1].timestamp,
        location: current.location,
        args: current.args,
      });
    } else {
      // Show individually
      for (let j = 0; j < count; j++) {
        const entry = logs[i + j];
        result.push({
          type: entry.type,
          text: entry.text,
          count: 1,
          firstTimestamp: entry.timestamp,
          lastTimestamp: entry.timestamp,
          location: entry.location,
          args: entry.args,
        });
      }
    }
    i += count;
  }
  return result;
}

// ---- Helpers ----

function makeLog(type: string, text: string, timestamp = 1000): ConsoleLogEntry {
  return { type, text, timestamp };
}

function makeLogs(type: string, text: string, count: number, baseTs = 1000): ConsoleLogEntry[] {
  return Array.from({ length: count }, (_, i) => makeLog(type, text, baseTs + i));
}

// ---- Tests ----

describe('deduplicateLogs', () => {
  describe('edge cases', () => {
    test('empty input returns empty array', () => {
      expect(deduplicateLogs([])).toEqual([]);
    });

    test('single log entry returns single entry with count 1', () => {
      const result = deduplicateLogs([makeLog('log', 'hello', 5000)]);
      expect(result).toHaveLength(1);
      expect(result[0].count).toBe(1);
      expect(result[0].text).toBe('hello');
      expect(result[0].type).toBe('log');
      expect(result[0].firstTimestamp).toBe(5000);
      expect(result[0].lastTimestamp).toBe(5000);
    });
  });

  describe('threshold behavior', () => {
    test('two identical logs (below threshold) are shown individually', () => {
      const logs = makeLogs('log', 'repeat', 2, 100);
      const result = deduplicateLogs(logs);
      expect(result).toHaveLength(2);
      expect(result[0].count).toBe(1);
      expect(result[1].count).toBe(1);
    });

    test('three identical logs (at threshold) are collapsed into one entry', () => {
      const logs = makeLogs('log', 'repeat', 3, 100);
      const result = deduplicateLogs(logs);
      expect(result).toHaveLength(1);
      expect(result[0].count).toBe(3);
      expect(result[0].text).toBe('repeat');
    });

    test('20 identical logs are collapsed into one entry with count 20', () => {
      const logs = makeLogs('log', 'flood', 20, 2000);
      const result = deduplicateLogs(logs);
      expect(result).toHaveLength(1);
      expect(result[0].count).toBe(20);
      expect(result[0].firstTimestamp).toBe(2000);
      expect(result[0].lastTimestamp).toBe(2019);
    });
  });

  describe('error and warning types are NEVER collapsed', () => {
    test('5 identical error messages are shown individually', () => {
      const logs = makeLogs('error', 'boom', 5, 100);
      const result = deduplicateLogs(logs);
      expect(result).toHaveLength(5);
      result.forEach(entry => {
        expect(entry.count).toBe(1);
        expect(entry.type).toBe('error');
      });
    });

    test('5 identical warning messages are shown individually', () => {
      const logs = makeLogs('warning', 'caution', 5, 100);
      const result = deduplicateLogs(logs);
      expect(result).toHaveLength(5);
      result.forEach(entry => {
        expect(entry.count).toBe(1);
        expect(entry.type).toBe('warning');
      });
    });
  });

  describe('mixed types', () => {
    test('3 log entries collapsed, 2 error entries shown individually', () => {
      const logs = [
        ...makeLogs('log', 'info', 3, 100),
        ...makeLogs('error', 'err', 2, 200),
      ];
      const result = deduplicateLogs(logs);
      // 1 collapsed log + 2 individual errors = 3 entries
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('log');
      expect(result[0].count).toBe(3);
      expect(result[1].type).toBe('error');
      expect(result[1].count).toBe(1);
      expect(result[2].type).toBe('error');
      expect(result[2].count).toBe(1);
    });
  });

  describe('non-consecutive grouping', () => {
    test('"A","B","A","A","A" — only trailing run of A is collapsed', () => {
      const logs = [
        makeLog('log', 'A', 1),
        makeLog('log', 'B', 2),
        makeLog('log', 'A', 3),
        makeLog('log', 'A', 4),
        makeLog('log', 'A', 5),
      ];
      const result = deduplicateLogs(logs);
      // A(1), B(1), A×3 → 3 entries
      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({ text: 'A', count: 1 });
      expect(result[1]).toMatchObject({ text: 'B', count: 1 });
      expect(result[2]).toMatchObject({ text: 'A', count: 3, firstTimestamp: 3, lastTimestamp: 5 });
    });

    test('three different texts are shown individually', () => {
      const logs = [
        makeLog('log', 'msg1', 1),
        makeLog('log', 'msg2', 2),
        makeLog('log', 'msg3', 3),
      ];
      const result = deduplicateLogs(logs);
      expect(result).toHaveLength(3);
      result.forEach(e => expect(e.count).toBe(1));
    });
  });

  describe('same text different type', () => {
    test('log "A" then warning "A" are NOT collapsed (different types)', () => {
      const logs = [
        makeLog('log', 'A', 1),
        makeLog('log', 'A', 2),
        makeLog('warning', 'A', 3),
        makeLog('warning', 'A', 4),
        makeLog('warning', 'A', 5),
      ];
      const result = deduplicateLogs(logs);
      // 2 logs individually (below threshold), 3 warnings individually (never dedup)
      expect(result).toHaveLength(5);
      expect(result[0]).toMatchObject({ type: 'log', count: 1 });
      expect(result[1]).toMatchObject({ type: 'log', count: 1 });
      expect(result[2]).toMatchObject({ type: 'warning', count: 1 });
      expect(result[3]).toMatchObject({ type: 'warning', count: 1 });
      expect(result[4]).toMatchObject({ type: 'warning', count: 1 });
    });
  });

  describe('timestamp preservation', () => {
    test('collapsed entry preserves firstTimestamp and lastTimestamp', () => {
      const logs = [
        makeLog('log', 'x', 1000),
        makeLog('log', 'x', 2000),
        makeLog('log', 'x', 3000),
      ];
      const result = deduplicateLogs(logs);
      expect(result[0].firstTimestamp).toBe(1000);
      expect(result[0].lastTimestamp).toBe(3000);
    });

    test('individual entry has matching firstTimestamp and lastTimestamp', () => {
      const logs = [makeLog('log', 'once', 9999)];
      const result = deduplicateLogs(logs);
      expect(result[0].firstTimestamp).toBe(9999);
      expect(result[0].lastTimestamp).toBe(9999);
    });
  });
});
