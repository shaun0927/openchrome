import { parseProcessMemory, selectProcessMemory } from '../../../src/core/process/memory';

describe('process memory collection', () => {
  const rows = [
    { pid: 10, parentPid: 1, residentBytes: 100, startedAt: 'root' },
    { pid: 11, parentPid: 10, residentBytes: 200, startedAt: 'child' },
    { pid: 12, parentPid: 11, residentBytes: 300, startedAt: 'grandchild' },
    { pid: 20, parentPid: 1, residentBytes: 999, startedAt: 'unrelated' },
  ];
  test('accounts for descendants without unrelated browsers', () => {
    expect(selectProcessMemory(rows, 10, true, 'win32')).toMatchObject({
      identity: '10:root', residentBytes: 600, processCount: 3, processIds: [10, 11, 12], metric: 'working-set',
    });
    expect(selectProcessMemory(rows, 10, false, 'linux').residentBytes).toBe(100);
  });
  test('missing root and creation identity are unavailable', () => {
    expect(() => selectProcessMemory(rows, 99, true, 'linux')).toThrow('unavailable');
    expect(() => selectProcessMemory([{ ...rows[0], startedAt: '' }], 10, true, 'win32')).toThrow('unavailable');
  });
  test('Windows handles one record or array and rejects absent memory', () => {
    const row = { ProcessId: 10, ParentProcessId: 1, WorkingSetSize: '2048', CreationDate: '2026-09-07T00:00:00Z' };
    expect(parseProcessMemory(JSON.stringify(row), 'win32')[0].residentBytes).toBe(2048);
    expect(parseProcessMemory(JSON.stringify([row]), 'win32')).toHaveLength(1);
    expect(() => parseProcessMemory(JSON.stringify({ ...row, WorkingSetSize: null }), 'win32')).toThrow();
  });
  test.each(['', 'not-json', 'null', '{"ProcessId":10}'])('rejects invalid Windows output %s', raw => {
    expect(() => parseProcessMemory(raw, 'win32')).toThrow();
  });
  test('Unix converts KB and retains start identity', () => {
    expect(parseProcessMemory('  10  1  2048 Mon Sep  7 10:00:00 2026\n', 'linux')[0]).toEqual({
      pid: 10, parentPid: 1, residentBytes: 2097152, startedAt: 'Mon Sep  7 10:00:00 2026',
    });
    expect(() => parseProcessMemory('10 1 nope date', 'linux')).toThrow();
  });
});
