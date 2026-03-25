/// <reference types="jest" />
/**
 * Unit tests for BrowserStateManager — Gap 2 (#416)
 *
 * Tests cover:
 *   - start()/stop() lifecycle: mkdir, setInterval, clearInterval
 *   - takeSnapshot(): correct JSON structure, file write, chmod, prune
 *   - takeSnapshot() skips when no cookie provider set
 *   - getLatestCookies(): reads newest file, null on empty dir
 *   - Prune logic: keeps only maxSnapshots, deletes oldest
 *   - getStatus(): snapshotCount and lastSnapshotAt
 *   - File permissions: chmod 0o600
 *   - Error handling: provider throws, getLatestCookies handles corrupt JSON
 */

import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mock fs/promises before importing the module under test
// ---------------------------------------------------------------------------

jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn(),
  readdir: jest.fn().mockResolvedValue([]),
  unlink: jest.fn().mockResolvedValue(undefined),
  chmod: jest.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs/promises';
import { BrowserStateManager } from '../../src/browser-state/snapshot';

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
const mockReaddir = fs.readdir as jest.MockedFunction<typeof fs.readdir>;
const mockUnlink = fs.unlink as jest.MockedFunction<typeof fs.unlink>;
const mockChmod = fs.chmod as jest.MockedFunction<typeof fs.chmod>;

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_COOKIES = [
  {
    name: 'session',
    value: 'abc123',
    domain: 'example.com',
    path: '/',
    expires: 9999999999,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  },
  {
    name: 'prefs',
    value: 'dark',
    domain: 'example.com',
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
  },
];

const SAMPLE_TAB_URLS = ['https://example.com', 'https://github.com'];

const SNAPSHOT_DIR = path.join(os.homedir(), '.openchrome', 'snapshots');

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('BrowserStateManager — start() / stop() lifecycle', () => {
  let manager: BrowserStateManager;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    manager = new BrowserStateManager({ intervalMs: 1000, maxSnapshots: 5 });
  });

  afterEach(() => {
    manager.stop();
    jest.useRealTimers();
  });

  test('1. start() creates snapshot directory', async () => {
    await manager.start();

    expect(mockMkdir).toHaveBeenCalledWith(SNAPSHOT_DIR, { recursive: true });
  });

  test('2. start() starts a setInterval timer', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    await manager.start();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
  });

  test('3. stop() clears the interval timer', async () => {
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    await manager.start();
    manager.stop();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  test('4. stop() before start() is a no-op — does not throw', () => {
    expect(() => manager.stop()).not.toThrow();
  });

  test('5. calling start() twice stops the previous timer before creating a new one', async () => {
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    await manager.start();
    await manager.start();

    // clearInterval called once to stop the first timer inside the second start()
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  test('6. timer does not fire synchronously — no immediate snapshot on start()', async () => {
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));
    await manager.start();

    // No time has advanced — writeFile must NOT have been called
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  test('7. timer fires after one interval — snapshot taken', async () => {
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));
    await manager.start();

    jest.advanceTimersByTime(1000);
    // Drain the microtask queue so the async takeSnapshot() resolves
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  test('8. stop() prevents further timer ticks', async () => {
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));
    await manager.start();
    manager.stop();

    jest.advanceTimersByTime(5000);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('BrowserStateManager — takeSnapshot()', () => {
  let manager: BrowserStateManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReaddir.mockResolvedValue([] as any);
    manager = new BrowserStateManager({ intervalMs: 60000, maxSnapshots: 5 });
  });

  test('9. skips snapshot when no cookie provider is registered', async () => {
    await manager.takeSnapshot();

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  test('10. writes JSON file with correct structure: cookies, tabUrls, timestamp', async () => {
    const before = Date.now();
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));
    manager.setTabUrlProvider(jest.fn().mockResolvedValue(SAMPLE_TAB_URLS));

    await manager.takeSnapshot();

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [filePath, rawContent] = mockWriteFile.mock.calls[0];

    // File lives inside the snapshot dir
    expect(filePath as string).toMatch(
      new RegExp(`^${SNAPSHOT_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]snapshot-\\d+\\.json$`)
    );

    const written = JSON.parse(rawContent as string);
    expect(written).toMatchObject({
      cookies: SAMPLE_COOKIES,
      tabUrls: SAMPLE_TAB_URLS,
    });
    expect(typeof written.timestamp).toBe('number');
    expect(written.timestamp).toBeGreaterThanOrEqual(before);
  });

  test('11. uses empty array for tabUrls when no tab URL provider is set', async () => {
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));
    // No setTabUrlProvider call

    await manager.takeSnapshot();

    const [, rawContent] = mockWriteFile.mock.calls[0];
    const written = JSON.parse(rawContent as string);
    expect(written.tabUrls).toEqual([]);
  });

  test('12. file written with utf-8 encoding', async () => {
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));

    await manager.takeSnapshot();

    const [, , encoding] = mockWriteFile.mock.calls[0];
    expect(encoding).toBe('utf-8');
  });

  test('13. chmod 0o600 called on the written file', async () => {
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));

    await manager.takeSnapshot();

    expect(mockChmod).toHaveBeenCalledWith(expect.stringContaining('snapshot-'), 0o600);
    // The path passed to chmod must match the path passed to writeFile
    const writtenPath = mockWriteFile.mock.calls[0][0];
    expect(mockChmod).toHaveBeenCalledWith(writtenPath, 0o600);
  });

  test('14. increments snapshotCount after each successful snapshot', async () => {
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));

    await manager.takeSnapshot();
    expect(manager.getStatus().snapshotCount).toBe(1);

    await manager.takeSnapshot();
    expect(manager.getStatus().snapshotCount).toBe(2);
  });

  test('15. updates lastSnapshotAt after successful snapshot', async () => {
    const before = Date.now();
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));

    await manager.takeSnapshot();

    expect(manager.getStatus().lastSnapshotAt).toBeGreaterThanOrEqual(before);
  });

  test('16. provider error is caught — does not throw, snapshotCount unchanged', async () => {
    manager.setCookieProvider(jest.fn().mockRejectedValue(new Error('CDP error')));

    await expect(manager.takeSnapshot()).resolves.toBeUndefined();
    expect(manager.getStatus().snapshotCount).toBe(0);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  test('17. tab URL provider error is caught — does not throw', async () => {
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));
    manager.setTabUrlProvider(jest.fn().mockRejectedValue(new Error('tabs unavailable')));

    await expect(manager.takeSnapshot()).resolves.toBeUndefined();
    // snapshotCount stays 0 because the error propagates up before writeFile
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('BrowserStateManager — prune logic', () => {
  let manager: BrowserStateManager;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('18. keeps only maxSnapshots newest files, deletes oldest when over limit', async () => {
    // 7 existing snapshot files, maxSnapshots = 3 → oldest 4 should be deleted
    const existingFiles = [
      'snapshot-1000.json',
      'snapshot-2000.json',
      'snapshot-3000.json',
      'snapshot-4000.json',
      'snapshot-5000.json',
      'snapshot-6000.json',
      'snapshot-7000.json',
      'unrelated.txt', // should be ignored
    ];
    mockReaddir.mockResolvedValue(existingFiles as any);
    manager = new BrowserStateManager({ intervalMs: 60000, maxSnapshots: 3 });
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));

    await manager.takeSnapshot();

    // After writing the new file, readdir returns 7 snapshot files.
    // sorted descending: 7000, 6000, 5000, 4000, 3000, 2000, 1000
    // slice(3) → delete: 4000, 3000, 2000, 1000
    const deletedFiles = mockUnlink.mock.calls.map(c => path.basename(c[0] as string));
    expect(deletedFiles).toContain('snapshot-4000.json');
    expect(deletedFiles).toContain('snapshot-3000.json');
    expect(deletedFiles).toContain('snapshot-2000.json');
    expect(deletedFiles).toContain('snapshot-1000.json');
    // Must NOT delete the 3 newest
    expect(deletedFiles).not.toContain('snapshot-7000.json');
    expect(deletedFiles).not.toContain('snapshot-6000.json');
    expect(deletedFiles).not.toContain('snapshot-5000.json');
  });

  test('19. does not delete any file when count is within maxSnapshots', async () => {
    const existingFiles = ['snapshot-1000.json', 'snapshot-2000.json'];
    mockReaddir.mockResolvedValue(existingFiles as any);
    manager = new BrowserStateManager({ intervalMs: 60000, maxSnapshots: 5 });
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));

    await manager.takeSnapshot();

    expect(mockUnlink).not.toHaveBeenCalled();
  });

  test('20. non-snapshot files (no prefix/suffix match) are not deleted', async () => {
    const existingFiles = [
      'snapshot-1000.json',
      'snapshot-2000.json',
      'snapshot-3000.json',
      'snapshot-4000.json',
      'other-file.json',
      'README.txt',
    ];
    mockReaddir.mockResolvedValue(existingFiles as any);
    manager = new BrowserStateManager({ intervalMs: 60000, maxSnapshots: 2 });
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));

    await manager.takeSnapshot();

    const deletedFiles = mockUnlink.mock.calls.map(c => path.basename(c[0] as string));
    expect(deletedFiles).not.toContain('other-file.json');
    expect(deletedFiles).not.toContain('README.txt');
  });

  test('21. readdir error during prune is silently swallowed', async () => {
    // First readdir call (from prune) rejects; takeSnapshot should still resolve
    mockReaddir.mockRejectedValue(new Error('readdir failed'));
    manager = new BrowserStateManager({ intervalMs: 60000, maxSnapshots: 3 });
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));

    await expect(manager.takeSnapshot()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('BrowserStateManager — getLatestCookies()', () => {
  let manager: BrowserStateManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new BrowserStateManager({ intervalMs: 60000, maxSnapshots: 5 });
  });

  test('22. returns null when no snapshot files exist', async () => {
    mockReaddir.mockResolvedValue([] as any);

    const result = await manager.getLatestCookies();

    expect(result).toBeNull();
  });

  test('23. returns cookies from the most recent snapshot file', async () => {
    mockReaddir.mockResolvedValue([
      'snapshot-1000.json',
      'snapshot-3000.json',
      'snapshot-2000.json',
    ] as any);

    const latestSnapshot = {
      timestamp: 3000,
      cookies: SAMPLE_COOKIES,
      tabUrls: SAMPLE_TAB_URLS,
    };
    mockReadFile.mockResolvedValue(JSON.stringify(latestSnapshot) as any);

    const result = await manager.getLatestCookies();

    expect(result).toEqual(SAMPLE_COOKIES);
    // Must have read from the highest-numbered (most recent) file
    const readPath = mockReadFile.mock.calls[0][0] as string;
    expect(readPath).toContain('snapshot-3000.json');
  });

  test('24. returns null when readdir throws', async () => {
    mockReaddir.mockRejectedValue(new Error('permission denied'));

    const result = await manager.getLatestCookies();

    expect(result).toBeNull();
  });

  test('25. returns null for corrupt JSON in snapshot file', async () => {
    mockReaddir.mockResolvedValue(['snapshot-1000.json'] as any);
    mockReadFile.mockResolvedValue('not-valid-json{{{' as any);

    const result = await manager.getLatestCookies();

    expect(result).toBeNull();
  });

  test('26. ignores non-snapshot files when finding the latest', async () => {
    mockReaddir.mockResolvedValue([
      'unrelated.txt',
      'other.json',
      'snapshot-5000.json',
    ] as any);

    const snap = { timestamp: 5000, cookies: SAMPLE_COOKIES, tabUrls: [] };
    mockReadFile.mockResolvedValue(JSON.stringify(snap) as any);

    const result = await manager.getLatestCookies();

    expect(result).toEqual(SAMPLE_COOKIES);
    const readPath = mockReadFile.mock.calls[0][0] as string;
    expect(readPath).toContain('snapshot-5000.json');
  });

  test('27. returns null when readFile throws', async () => {
    mockReaddir.mockResolvedValue(['snapshot-1000.json'] as any);
    mockReadFile.mockRejectedValue(new Error('file read error'));

    const result = await manager.getLatestCookies();

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('BrowserStateManager — getStatus()', () => {
  let manager: BrowserStateManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReaddir.mockResolvedValue([] as any);
    manager = new BrowserStateManager({ intervalMs: 60000, maxSnapshots: 5 });
  });

  test('28. returns zero counts before any snapshot is taken', () => {
    const status = manager.getStatus();

    expect(status.snapshotCount).toBe(0);
    expect(status.lastSnapshotAt).toBe(0);
  });

  test('29. snapshotCount increments with each successful snapshot', async () => {
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));

    await manager.takeSnapshot();
    await manager.takeSnapshot();
    await manager.takeSnapshot();

    expect(manager.getStatus().snapshotCount).toBe(3);
  });

  test('30. lastSnapshotAt is updated to approximately Date.now() after snapshot', async () => {
    const before = Date.now();
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));

    await manager.takeSnapshot();

    const after = Date.now();
    const { lastSnapshotAt } = manager.getStatus();
    expect(lastSnapshotAt).toBeGreaterThanOrEqual(before);
    expect(lastSnapshotAt).toBeLessThanOrEqual(after);
  });

  test('31. failed snapshot does not update lastSnapshotAt', async () => {
    manager.setCookieProvider(jest.fn().mockRejectedValue(new Error('CDP error')));

    await manager.takeSnapshot();

    expect(manager.getStatus().lastSnapshotAt).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('BrowserStateManager — file permissions', () => {
  let manager: BrowserStateManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReaddir.mockResolvedValue([] as any);
    manager = new BrowserStateManager({ intervalMs: 60000, maxSnapshots: 5 });
  });

  test('32. chmod 0o600 is called on the snapshot file after writing', async () => {
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));

    await manager.takeSnapshot();

    expect(mockChmod).toHaveBeenCalledTimes(1);
    expect(mockChmod.mock.calls[0][1]).toBe(0o600);
  });

  test('33. chmod path matches the writeFile path', async () => {
    manager.setCookieProvider(jest.fn().mockResolvedValue(SAMPLE_COOKIES));

    await manager.takeSnapshot();

    const writtenPath = mockWriteFile.mock.calls[0][0];
    const chmodPath = mockChmod.mock.calls[0][0];
    expect(chmodPath).toBe(writtenPath);
  });
});

// ---------------------------------------------------------------------------

describe('BrowserStateManager — constructor defaults', () => {
  test('34. uses DEFAULT_SNAPSHOT_INTERVAL_MS and DEFAULT_SNAPSHOT_MAX_COUNT when no opts provided', async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockReaddir.mockResolvedValue([] as any);

    const cookieFn = jest.fn().mockResolvedValue(SAMPLE_COOKIES);
    const manager = new BrowserStateManager();
    manager.setCookieProvider(cookieFn);

    await manager.start();

    // Default interval is 60000ms — advancing 59999 should NOT trigger a snapshot
    jest.advanceTimersByTime(59999);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockWriteFile).not.toHaveBeenCalled();

    // Advancing past 60000 should trigger one snapshot
    jest.advanceTimersByTime(2);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    manager.stop();
    jest.useRealTimers();
  });
});
