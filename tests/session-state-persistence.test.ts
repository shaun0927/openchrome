/// <reference types="jest" />

import { SessionStatePersistence, PersistedSessionState } from '../src/session-state-persistence';
import { writeFileAtomicSafe, readFileSafe } from '../src/utils/atomic-file';

jest.mock('../src/utils/atomic-file', () => ({
  writeFileAtomicSafe: jest.fn().mockResolvedValue(undefined),
  readFileSafe: jest.fn(),
}));

const mockWriteFileAtomicSafe = writeFileAtomicSafe as jest.MockedFunction<typeof writeFileAtomicSafe>;
const mockReadFileSafe = readFileSafe as jest.MockedFunction<typeof readFileSafe>;

const SAMPLE_STATE: PersistedSessionState = {
  version: 1,
  timestamp: Date.now(),
  sessions: [
    {
      id: 'default',
      workers: [
        {
          id: 'default',
          targets: [
            { targetId: 'ABC123', url: 'https://example.com' },
            { targetId: 'DEF456', url: 'https://github.com' },
          ],
        },
      ],
      lastActivityAt: Date.now(),
    },
  ],
};

describe('SessionStatePersistence', () => {
  let persistence: SessionStatePersistence;

  beforeEach(() => {
    persistence = new SessionStatePersistence({ dir: '/tmp', debounceMs: 50 });
    jest.clearAllMocks();
  });

  afterEach(() => {
    persistence.cancelPendingSave();
  });

  describe('save', () => {
    test('writes state to disk with atomic write', async () => {
      await persistence.save(SAMPLE_STATE);

      expect(mockWriteFileAtomicSafe).toHaveBeenCalledWith(
        expect.stringContaining('session-state.json'),
        expect.objectContaining({
          version: 1,
          sessions: SAMPLE_STATE.sessions,
        })
      );
    });

    test('queues concurrent save so state is not dropped', async () => {
      let resolveFirst!: () => void;
      mockWriteFileAtomicSafe.mockImplementationOnce(
        () => new Promise(resolve => { resolveFirst = () => resolve(undefined); })
      );

      const p1 = persistence.save(SAMPLE_STATE);
      const p2 = persistence.save(SAMPLE_STATE);

      resolveFirst();
      await Promise.all([p1, p2]);

      // p2 was queued and runs after p1 completes — two writes total
      expect(mockWriteFileAtomicSafe).toHaveBeenCalledTimes(2);
    });

    test('updates timestamp on save', async () => {
      const before = Date.now();
      await persistence.save(SAMPLE_STATE);
      const after = Date.now();

      const [, written] = mockWriteFileAtomicSafe.mock.calls[0];
      const state = written as PersistedSessionState;
      expect(state.timestamp).toBeGreaterThanOrEqual(before);
      expect(state.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('restore', () => {
    test('restores valid state from disk', async () => {
      mockReadFileSafe.mockResolvedValue({ success: true, data: SAMPLE_STATE });

      const result = await persistence.restore();

      expect(result).toEqual(SAMPLE_STATE);
    });

    test('returns null for missing file', async () => {
      mockReadFileSafe.mockResolvedValue({ success: false, error: 'not found' });

      const result = await persistence.restore();
      expect(result).toBeNull();
    });

    test('returns null for wrong version', async () => {
      mockReadFileSafe.mockResolvedValue({
        success: true,
        data: { ...SAMPLE_STATE, version: 99 },
      });

      const result = await persistence.restore();
      expect(result).toBeNull();
    });

    test('returns null for invalid structure', async () => {
      mockReadFileSafe.mockResolvedValue({
        success: true,
        data: { version: 1, timestamp: Date.now(), sessions: 'not-an-array' },
      });

      const result = await persistence.restore();
      expect(result).toBeNull();
    });
  });

  describe('staleness TTL', () => {
    test('should restore fresh snapshot (1h old)', async () => {
      const freshState: PersistedSessionState = {
        ...SAMPLE_STATE,
        timestamp: Date.now() - 1 * 60 * 60 * 1000, // 1 hour ago
      };
      mockReadFileSafe.mockResolvedValue({ success: true, data: freshState });

      const result = await persistence.restore();

      expect(result).toEqual(freshState);
    });

    test('should reject stale snapshot (25h old, default 24h TTL)', async () => {
      const staleState: PersistedSessionState = {
        ...SAMPLE_STATE,
        timestamp: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      };
      mockReadFileSafe.mockResolvedValue({ success: true, data: staleState });

      const result = await persistence.restore();

      expect(result).toBeNull();
    });

    test('should respect custom maxStalenessMs', async () => {
      const customPersistence = new SessionStatePersistence({
        dir: '/tmp',
        debounceMs: 50,
        maxStalenessMs: 1 * 60 * 60 * 1000, // 1 hour TTL
      });
      const staleState: PersistedSessionState = {
        ...SAMPLE_STATE,
        timestamp: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
      };
      mockReadFileSafe.mockResolvedValue({ success: true, data: staleState });

      const result = await customPersistence.restore();

      expect(result).toBeNull();
      customPersistence.cancelPendingSave();
    });

    test('should restore snapshot with no timestamp (legacy)', async () => {
      const legacyState = {
        version: 1 as const,
        sessions: SAMPLE_STATE.sessions,
        // no timestamp field
      } as unknown as PersistedSessionState;
      mockReadFileSafe.mockResolvedValue({ success: true, data: legacyState });

      const result = await persistence.restore();

      expect(result).toEqual(legacyState);
    });
  });

  describe('scheduleSave', () => {
    test('debounces multiple save calls', async () => {
      persistence.scheduleSave(SAMPLE_STATE);
      persistence.scheduleSave(SAMPLE_STATE);
      persistence.scheduleSave(SAMPLE_STATE);

      // Wait for debounce
      await new Promise(r => setTimeout(r, 100));

      expect(mockWriteFileAtomicSafe).toHaveBeenCalledTimes(1);
    });

    test('cancelPendingSave prevents write', async () => {
      persistence.scheduleSave(SAMPLE_STATE);
      persistence.cancelPendingSave();

      await new Promise(r => setTimeout(r, 100));

      expect(mockWriteFileAtomicSafe).not.toHaveBeenCalled();
    });
  });

  describe('createSnapshot', () => {
    test('converts in-memory session structure to persisted format', () => {
      const sessions = new Map();
      // targets is Set<string> of bare CDP target IDs — no URL stored in memory
      const targets = new Set(['T1', 'T2']);

      const workers = new Map();
      workers.set('default', { id: 'default', targets });

      sessions.set('default', { workers, lastActivityAt: 1000 });

      const snapshot = SessionStatePersistence.createSnapshot(sessions);

      expect(snapshot.version).toBe(1);
      expect(snapshot.sessions).toHaveLength(1);
      expect(snapshot.sessions[0].id).toBe('default');
      expect(snapshot.sessions[0].workers[0].targets).toHaveLength(2);
      // URLs are not tracked in memory; persisted as placeholder
      expect(snapshot.sessions[0].workers[0].targets[0].url).toBe('about:blank');
    });

    test('handles empty sessions', () => {
      const sessions = new Map();
      const snapshot = SessionStatePersistence.createSnapshot(sessions);

      expect(snapshot.sessions).toHaveLength(0);
    });
  });

  describe('clear', () => {
    test('does not throw when file does not exist', async () => {
      await expect(persistence.clear()).resolves.not.toThrow();
    });
  });

  describe('getFilePath', () => {
    test('returns correct file path', () => {
      expect(persistence.getFilePath()).toContain('session-state.json');
    });
  });
});
