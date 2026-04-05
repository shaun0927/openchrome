/**
 * Tests for RecordingStore — disk storage for session recordings.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RecordingStore, RECORDING_ID_PATTERN } from '../../src/recording/recording-store';
import { RecordingAction, RecordingMetadata, DEFAULT_RECORDING_CONFIG } from '../../src/recording/types';

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `recording-store-test-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

function makeMetadata(id: string, sessionId = 'sess-1'): RecordingMetadata {
  return {
    version: 1,
    id,
    sessionId,
    startedAt: new Date().toISOString(),
    actionCount: 0,
  };
}

function makeAction(seq: number): RecordingAction {
  return {
    seq,
    ts: Date.now(),
    tool: 'navigate',
    args: { url: `https://example${seq}.com` },
    durationMs: 100,
    ok: true,
    summary: `✓ → https://example${seq}.com`,
  };
}

describe('RecordingStore', () => {
  let dir: string;
  let store: RecordingStore;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new RecordingStore(dir);
  });

  afterEach(() => {
    cleanupDir(dir);
  });

  // -------------------------------------------------------------------------
  // init()
  // -------------------------------------------------------------------------
  describe('init()', () => {
    it('creates the base directory if it does not exist', async () => {
      const newDir = path.join(os.tmpdir(), `recording-store-init-${Math.random().toString(36).slice(2)}`);
      const s = new RecordingStore(newDir);
      try {
        await s.init();
        expect(fs.existsSync(newDir)).toBe(true);
      } finally {
        cleanupDir(newDir);
      }
    });
  });

  // -------------------------------------------------------------------------
  // createRecording()
  // -------------------------------------------------------------------------
  describe('createRecording()', () => {
    it('creates a recording directory and metadata file', async () => {
      const id = 'rec-20240101-120000-abcd';
      const metadata = makeMetadata(id);
      await store.createRecording(metadata);

      const recDir = store.getRecordingDir(id);
      expect(fs.existsSync(recDir)).toBe(true);
      expect(fs.existsSync(path.join(recDir, 'metadata.json'))).toBe(true);
    });

    it('metadata file contains valid JSON matching the input', async () => {
      const id = 'rec-20240101-120000-efgh';
      const metadata = makeMetadata(id);
      await store.createRecording(metadata);

      const content = fs.readFileSync(path.join(store.getRecordingDir(id), 'metadata.json'), 'utf-8');
      const parsed = JSON.parse(content) as RecordingMetadata;
      expect(parsed.id).toBe(id);
      expect(parsed.sessionId).toBe('sess-1');
      expect(parsed.version).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // appendAction() + readActions()
  // -------------------------------------------------------------------------
  describe('appendAction() + readActions()', () => {
    it('writes and reads back a single action', async () => {
      const id = 'rec-20240101-120000-act1';
      await store.createRecording(makeMetadata(id));
      const action = makeAction(1);
      store.appendAction(id, action);

      const actions = store.readActions(id);
      expect(actions).toHaveLength(1);
      expect(actions[0].seq).toBe(1);
      expect(actions[0].tool).toBe('navigate');
    });

    it('writes and reads back multiple actions', async () => {
      const id = 'rec-20240101-120000-act2';
      await store.createRecording(makeMetadata(id));

      for (let i = 1; i <= 5; i++) {
        store.appendAction(id, makeAction(i));
      }

      const actions = store.readActions(id);
      expect(actions).toHaveLength(5);
      expect(actions.map(a => a.seq)).toEqual([1, 2, 3, 4, 5]);
    });

    it('each line in actions.jsonl is valid JSON', async () => {
      const id = 'rec-20240101-120000-jsonl';
      await store.createRecording(makeMetadata(id));
      store.appendAction(id, makeAction(1));
      store.appendAction(id, makeAction(2));

      const actionsFile = path.join(store.getRecordingDir(id), 'actions.jsonl');
      const lines = fs.readFileSync(actionsFile, 'utf-8').split('\n').filter(l => l.trim());
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('skips malformed JSONL lines when reading', async () => {
      const id = 'rec-20240101-120000-baad';
      await store.createRecording(makeMetadata(id));
      store.appendAction(id, makeAction(1));

      // Inject a corrupt line
      const actionsFile = path.join(store.getRecordingDir(id), 'actions.jsonl');
      fs.appendFileSync(actionsFile, 'NOT_VALID_JSON\n');

      store.appendAction(id, makeAction(2));

      const actions = store.readActions(id);
      expect(actions).toHaveLength(2);
      expect(actions[0].seq).toBe(1);
      expect(actions[1].seq).toBe(2);
    });

    it('returns empty array when actions file does not exist', () => {
      const actions = store.readActions('rec-20240101-120000-none');
      expect(actions).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // readMetadata() + writeMetadata()
  // -------------------------------------------------------------------------
  describe('readMetadata() + writeMetadata()', () => {
    it('reads metadata back after creation', async () => {
      const id = 'rec-20240101-120000-meta';
      const metadata = makeMetadata(id);
      await store.createRecording(metadata);

      const read = await store.readMetadata(id);
      expect(read).not.toBeNull();
      expect(read!.id).toBe(id);
    });

    it('overwrites metadata with writeMetadata()', async () => {
      const id = 'rec-20240101-120000-upd1';
      const metadata = makeMetadata(id);
      await store.createRecording(metadata);

      const updated: RecordingMetadata = { ...metadata, actionCount: 42, stoppedAt: new Date().toISOString() };
      await store.writeMetadata(updated);

      const read = await store.readMetadata(id);
      expect(read!.actionCount).toBe(42);
      expect(read!.stoppedAt).toBeDefined();
    });

    it('returns null when metadata does not exist', async () => {
      const result = await store.readMetadata('rec-20240101-120000-nope');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // saveScreenshot() + readScreenshot()
  // -------------------------------------------------------------------------
  describe('saveScreenshot() + readScreenshot()', () => {
    it('saves and reads back a screenshot buffer', async () => {
      const id = 'rec-20240101-120000-ss01';
      await store.createRecording(makeMetadata(id));

      const buf = Buffer.from('fake-screenshot-data');
      await store.saveScreenshot(id, 'screenshot-1-before.webp', buf);

      const read = await store.readScreenshot(id, 'screenshot-1-before.webp');
      expect(read).not.toBeNull();
      expect(read!.equals(buf)).toBe(true);
    });

    it('returns null when screenshot does not exist', async () => {
      const id = 'rec-20240101-120000-ss02';
      await store.createRecording(makeMetadata(id));

      const result = await store.readScreenshot(id, 'nonexistent.webp');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // listRecordings()
  // -------------------------------------------------------------------------
  describe('listRecordings()', () => {
    it('returns empty array when no recordings exist', async () => {
      const result = await store.listRecordings();
      expect(result).toEqual([]);
    });

    it('lists created recordings sorted newest first', async () => {
      const ids = [
        'rec-20240101-100000-aaaa',
        'rec-20240101-120000-bbbb',
        'rec-20240101-140000-cccc',
      ];
      for (const id of ids) {
        await store.createRecording(makeMetadata(id));
      }

      const result = await store.listRecordings();
      expect(result).toEqual([
        'rec-20240101-140000-cccc',
        'rec-20240101-120000-bbbb',
        'rec-20240101-100000-aaaa',
      ]);
    });

    it('only returns entries starting with rec-', async () => {
      await store.createRecording(makeMetadata('rec-20240101-120000-test'));
      // Create a non-recording directory
      fs.mkdirSync(path.join(dir, 'other-dir'), { recursive: true });

      const result = await store.listRecordings();
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('rec-20240101-120000-test');
    });
  });

  // -------------------------------------------------------------------------
  // deleteRecording()
  // -------------------------------------------------------------------------
  describe('deleteRecording()', () => {
    it('deletes a recording directory and its contents', async () => {
      const id = 'rec-20240101-120000-del1';
      await store.createRecording(makeMetadata(id));
      store.appendAction(id, makeAction(1));

      const recDir = store.getRecordingDir(id);
      expect(fs.existsSync(recDir)).toBe(true);

      await store.deleteRecording(id);
      expect(fs.existsSync(recDir)).toBe(false);
    });

    it('does not throw when deleting a nonexistent recording', async () => {
      await expect(store.deleteRecording('rec-20240101-120000-noid')).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // cleanup()
  // -------------------------------------------------------------------------
  describe('cleanup()', () => {
    it('removes recordings older than retentionDays', async () => {
      const s = new RecordingStore(dir, { retentionDays: 3, maxRecordings: 50 });

      // Old recording (10 days ago)
      const oldDate = new Date(Date.now() - 10 * 86400000);
      const oldId = `rec-${oldDate.getUTCFullYear()}${String(oldDate.getUTCMonth() + 1).padStart(2, '0')}${String(oldDate.getUTCDate()).padStart(2, '0')}-000000-old1`;
      await s.createRecording(makeMetadata(oldId));

      // Recent recording (1 day ago)
      const recentDate = new Date(Date.now() - 1 * 86400000);
      const recentId = `rec-${recentDate.getUTCFullYear()}${String(recentDate.getUTCMonth() + 1).padStart(2, '0')}${String(recentDate.getUTCDate()).padStart(2, '0')}-000000-new1`;
      await s.createRecording(makeMetadata(recentId));

      await s.cleanup();

      const remaining = await s.listRecordings();
      expect(remaining).not.toContain(oldId);
      expect(remaining).toContain(recentId);
    });

    it('removes excess recordings beyond maxRecordings', async () => {
      const s = new RecordingStore(dir, { retentionDays: 365, maxRecordings: 2 });

      // Create 4 recordings using recent dates (today) to avoid expiry deletion
      const today = new Date();
      const ymd = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, '0')}${String(today.getUTCDate()).padStart(2, '0')}`;
      const ids = [
        `rec-${ymd}-100000-aaa1`,
        `rec-${ymd}-110000-aaa2`,
        `rec-${ymd}-120000-aaa3`,
        `rec-${ymd}-130000-aaa4`,
      ];
      for (const id of ids) {
        await s.createRecording(makeMetadata(id));
      }

      await s.cleanup();

      const remaining = await s.listRecordings();
      expect(remaining).toHaveLength(2);
      // Newest two should remain
      expect(remaining).toContain(`rec-${ymd}-130000-aaa4`);
      expect(remaining).toContain(`rec-${ymd}-120000-aaa3`);
    });

    it('does not throw when base directory is empty', async () => {
      await expect(store.cleanup()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getRecordingSize()
  // -------------------------------------------------------------------------
  describe('getRecordingSize()', () => {
    it('returns 0 for nonexistent recording', async () => {
      const size = await store.getRecordingSize('rec-20240101-120000-nosz');
      expect(size).toBe(0);
    });

    it('returns total size of all files in the recording directory', async () => {
      const id = 'rec-20240101-120000-sz01';
      await store.createRecording(makeMetadata(id));
      store.appendAction(id, makeAction(1));

      const size = await store.getRecordingSize(id);
      expect(size).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Security: path traversal & filename validation
  // -------------------------------------------------------------------------
  describe('security', () => {
    it('rejects recording IDs with path traversal', () => {
      expect(() => store.getRecordingDir('../../etc')).toThrow('Invalid recording id');
      expect(() => store.getRecordingDir('../../../tmp/evil')).toThrow('Invalid recording id');
    });

    it('rejects recording IDs that do not match the expected format', () => {
      expect(() => store.getRecordingDir('nonexistent')).toThrow('Invalid recording id');
      expect(() => store.getRecordingDir('')).toThrow('Invalid recording id');
      expect(() => store.getRecordingDir('rec-bad')).toThrow('Invalid recording id');
    });

    it('accepts valid recording IDs', () => {
      expect(() => store.getRecordingDir('rec-20240101-120000-abcd')).not.toThrow();
      expect(() => store.getRecordingDir('rec-20240101-120000-ab01cd')).not.toThrow();
    });

    it('rejects screenshot filenames with path separators', async () => {
      const id = 'rec-20240101-120000-sec1';
      await store.createRecording(makeMetadata(id));

      await expect(store.saveScreenshot(id, '../../../etc/passwd', Buffer.from('x'))).rejects.toThrow('Invalid filename');
      await expect(store.readScreenshot(id, '../../secret.txt')).rejects.toThrow('Invalid filename');
    });

    it('accepts valid screenshot filenames', async () => {
      const id = 'rec-20240101-120000-sec2';
      await store.createRecording(makeMetadata(id));

      await expect(store.saveScreenshot(id, 'screenshot-1-before.webp', Buffer.from('data'))).resolves.not.toThrow();
    });

    it('RECORDING_ID_PATTERN matches expected format', () => {
      expect(RECORDING_ID_PATTERN.test('rec-20240101-120000-abcd')).toBe(true);
      expect(RECORDING_ID_PATTERN.test('rec-20240101-120000-ab01cd')).toBe(true);
      expect(RECORDING_ID_PATTERN.test('../../etc')).toBe(false);
      expect(RECORDING_ID_PATTERN.test('rec-bad')).toBe(false);
    });
  });
});
