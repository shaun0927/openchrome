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

    test('prevents concurrent saves', async () => {
      let resolveFirst!: () => void;
      mockWriteFileAtomicSafe.mockImplementationOnce(
        () => new Promise(resolve => { resolveFirst = () => resolve(undefined); })
      );

      const p1 = persistence.save(SAMPLE_STATE);
      const p2 = persistence.save(SAMPLE_STATE);

      resolveFirst();
      await Promise.all([p1, p2]);

      expect(mockWriteFileAtomicSafe).toHaveBeenCalledTimes(1);
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
      const targets = new Map();
      targets.set('T1', { url: 'https://example.com' });
      targets.set('T2', { url: 'https://github.com' });

      const workers = new Map();
      workers.set('default', { id: 'default', targets });

      sessions.set('default', { workers, lastActivityAt: 1000 });

      const snapshot = SessionStatePersistence.createSnapshot(sessions);

      expect(snapshot.version).toBe(1);
      expect(snapshot.sessions).toHaveLength(1);
      expect(snapshot.sessions[0].id).toBe('default');
      expect(snapshot.sessions[0].workers[0].targets).toHaveLength(2);
      expect(snapshot.sessions[0].workers[0].targets[0].url).toBe('https://example.com');
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
