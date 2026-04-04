/**
 * Tests for ActionRecorder — main recording orchestration class.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ActionRecorder, generateRecordingId } from '../../src/recording/action-recorder';
import { RecordingStore } from '../../src/recording/recording-store';
import { RecordingAction } from '../../src/recording/types';

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `action-recorder-test-${Math.random().toString(36).slice(2)}`);
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

describe('generateRecordingId()', () => {
  it('returns a string matching the rec-YYYYMMDD-HHMMSS-xxxx format', () => {
    const id = generateRecordingId();
    expect(id).toMatch(/^rec-\d{8}-\d{6}-[a-z0-9]{4}$/);
  });

  it('generates unique IDs on consecutive calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateRecordingId()));
    // With random 4-char suffix, collisions are extremely unlikely
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe('ActionRecorder', () => {
  let dir: string;
  let store: RecordingStore;
  let recorder: ActionRecorder;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new RecordingStore(dir);
    recorder = new ActionRecorder(store, { captureScreenshots: false });
  });

  afterEach(() => {
    cleanupDir(dir);
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------
  describe('initial state', () => {
    it('isRecording is false initially', () => {
      expect(recorder.isRecording).toBe(false);
    });

    it('activeRecordingId is null initially', () => {
      expect(recorder.activeRecordingId).toBeNull();
    });

    it('activeMetadata is null initially', () => {
      expect(recorder.activeMetadata).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // start() / stop() lifecycle
  // -------------------------------------------------------------------------
  describe('start() / stop() lifecycle', () => {
    it('start() sets isRecording to true', async () => {
      await recorder.start('sess-1');
      expect(recorder.isRecording).toBe(true);
    });

    it('start() sets activeRecordingId to a valid id', async () => {
      await recorder.start('sess-1');
      expect(recorder.activeRecordingId).toMatch(/^rec-\d{8}-\d{6}-[a-z0-9]{4}$/);
    });

    it('start() sets activeMetadata with correct fields', async () => {
      const before = new Date().toISOString();
      await recorder.start('sess-1', { label: 'test run', profile: 'default' });
      const meta = recorder.activeMetadata;
      expect(meta).not.toBeNull();
      expect(meta!.sessionId).toBe('sess-1');
      expect(meta!.label).toBe('test run');
      expect(meta!.profile).toBe('default');
      expect(meta!.version).toBe(1);
      expect(meta!.startedAt >= before).toBe(true);
    });

    it('start() creates a recording directory on disk', async () => {
      await recorder.start('sess-1');
      const id = recorder.activeRecordingId!;
      expect(fs.existsSync(store.getRecordingDir(id))).toBe(true);
    });

    it('stop() sets isRecording to false', async () => {
      await recorder.start('sess-1');
      await recorder.stop();
      expect(recorder.isRecording).toBe(false);
    });

    it('stop() sets activeRecordingId to null', async () => {
      await recorder.start('sess-1');
      await recorder.stop();
      expect(recorder.activeRecordingId).toBeNull();
    });

    it('stop() sets activeMetadata to null', async () => {
      await recorder.start('sess-1');
      await recorder.stop();
      expect(recorder.activeMetadata).toBeNull();
    });

    it('stop() returns metadata with stoppedAt set', async () => {
      await recorder.start('sess-1');
      const meta = await recorder.stop();
      expect(meta.stoppedAt).toBeDefined();
    });

    it('stop() writes final metadata to disk', async () => {
      await recorder.start('sess-1');
      const id = recorder.activeRecordingId!;
      const finalMeta = await recorder.stop();

      const onDisk = await store.readMetadata(id);
      expect(onDisk).not.toBeNull();
      expect(onDisk!.stoppedAt).toBe(finalMeta.stoppedAt);
    });

    it('activeMetadata returns a snapshot copy (not mutable reference)', async () => {
      await recorder.start('sess-1');
      const meta1 = recorder.activeMetadata;
      const meta2 = recorder.activeMetadata;
      expect(meta1).not.toBe(meta2); // different object references
      expect(meta1).toEqual(meta2);  // same values
    });
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------
  describe('error cases', () => {
    it('throws on double start()', async () => {
      await recorder.start('sess-1');
      await expect(recorder.start('sess-2')).rejects.toThrow('already active');
    });

    it('throws when stop() called without start()', async () => {
      await expect(recorder.stop()).rejects.toThrow('No active recording');
    });

    it('throws when stop() called twice', async () => {
      await recorder.start('sess-1');
      await recorder.stop();
      await expect(recorder.stop()).rejects.toThrow('No active recording');
    });
  });

  // -------------------------------------------------------------------------
  // recordAction()
  // -------------------------------------------------------------------------
  describe('recordAction()', () => {
    it('is a no-op when not recording', async () => {
      // Should not throw
      await expect(
        recorder.recordAction('navigate', { url: 'https://example.com' }, 100, true),
      ).resolves.not.toThrow();
    });

    it('writes an action to JSONL when recording', async () => {
      await recorder.start('sess-1');
      const id = recorder.activeRecordingId!;

      await recorder.recordAction('navigate', { url: 'https://example.com' }, 100, true, {
        summary: '✓ → https://example.com',
      });

      const actions = store.readActions(id);
      expect(actions).toHaveLength(1);
      expect(actions[0].tool).toBe('navigate');
      expect(actions[0].ok).toBe(true);
      expect(actions[0].durationMs).toBe(100);
      expect(actions[0].summary).toBe('✓ → https://example.com');
    });

    it('increments seq for each action', async () => {
      await recorder.start('sess-1');
      const id = recorder.activeRecordingId!;

      await recorder.recordAction('navigate', {}, 10, true);
      await recorder.recordAction('read_page', {}, 10, true);
      await recorder.recordAction('interact', {}, 10, true);

      const actions = store.readActions(id);
      expect(actions.map(a => a.seq)).toEqual([1, 2, 3]);
    });

    it('records error field when ok=false', async () => {
      await recorder.start('sess-1');
      const id = recorder.activeRecordingId!;

      await recorder.recordAction('navigate', {}, 50, false, { error: 'Navigation failed' });

      const actions = store.readActions(id);
      expect(actions[0].ok).toBe(false);
      expect(actions[0].error).toBe('Navigation failed');
    });

    it('records tabId from opts when provided', async () => {
      await recorder.start('sess-1');
      const id = recorder.activeRecordingId!;

      await recorder.recordAction('read_page', {}, 30, true, { tabId: 'tab-42' });

      const actions = store.readActions(id);
      expect(actions[0].tabId).toBe('tab-42');
    });

    it('extracts tabId from args when not in opts', async () => {
      await recorder.start('sess-1');
      const id = recorder.activeRecordingId!;

      await recorder.recordAction('read_page', { tabId: 'tab-99' }, 30, true);

      const actions = store.readActions(id);
      expect(actions[0].tabId).toBe('tab-99');
    });

    it('updates actionCount in activeMetadata', async () => {
      await recorder.start('sess-1');

      await recorder.recordAction('navigate', {}, 10, true);
      await recorder.recordAction('read_page', {}, 10, true);

      expect(recorder.activeMetadata!.actionCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Arg sanitization
  // -------------------------------------------------------------------------
  describe('arg sanitization', () => {
    it('redacts password field', async () => {
      await recorder.start('sess-1');
      const id = recorder.activeRecordingId!;

      await recorder.recordAction('fill_form', { password: 'hunter2', username: 'alice' }, 10, true);

      const actions = store.readActions(id);
      expect(actions[0].args['password']).toBe('[REDACTED]');
      expect(actions[0].args['username']).toBe('alice');
    });

    it('redacts token field', async () => {
      await recorder.start('sess-1');
      const id = recorder.activeRecordingId!;

      await recorder.recordAction('navigate', { token: 'abc123', url: 'https://example.com' }, 10, true);

      const actions = store.readActions(id);
      expect(actions[0].args['token']).toBe('[REDACTED]');
      expect(actions[0].args['url']).toBe('https://example.com');
    });

    it('redacts secret field', async () => {
      await recorder.start('sess-1');
      const id = recorder.activeRecordingId!;

      await recorder.recordAction('navigate', { secret: 'shh' }, 10, true);

      const actions = store.readActions(id);
      expect(actions[0].args['secret']).toBe('[REDACTED]');
    });

    it('redacts credential field', async () => {
      await recorder.start('sess-1');
      const id = recorder.activeRecordingId!;

      await recorder.recordAction('navigate', { credential: 'cred' }, 10, true);

      const actions = store.readActions(id);
      expect(actions[0].args['credential']).toBe('[REDACTED]');
    });

    it('redacts api_key field', async () => {
      await recorder.start('sess-1');
      const id = recorder.activeRecordingId!;

      await recorder.recordAction('navigate', { api_key: 'key123' }, 10, true);

      const actions = store.readActions(id);
      expect(actions[0].args['api_key']).toBe('[REDACTED]');
    });

    it('passes through non-sensitive args unchanged', async () => {
      await recorder.start('sess-1');
      const id = recorder.activeRecordingId!;

      await recorder.recordAction('navigate', { url: 'https://example.com', tabId: 'tab-1' }, 10, true);

      const actions = store.readActions(id);
      expect(actions[0].args['url']).toBe('https://example.com');
      expect(actions[0].args['tabId']).toBe('tab-1');
    });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle test
  // -------------------------------------------------------------------------
  describe('full lifecycle', () => {
    it('records a complete session and reads it back correctly', async () => {
      await recorder.start('sess-full', { label: 'full test' });
      const id = recorder.activeRecordingId!;

      await recorder.recordAction('navigate', { url: 'https://a.com' }, 200, true, { summary: '✓ → https://a.com' });
      await recorder.recordAction('read_page', {}, 50, true, { summary: '✓ Read page' });
      await recorder.recordAction('interact', { description: 'Submit' }, 100, false, {
        summary: '✗ interact',
        error: 'Element not found',
      });

      const finalMeta = await recorder.stop();

      // Verify metadata on disk
      const onDisk = await store.readMetadata(id);
      expect(onDisk!.actionCount).toBe(3);
      expect(onDisk!.stoppedAt).toBe(finalMeta.stoppedAt);
      expect(onDisk!.label).toBe('full test');

      // Verify actions on disk
      const actions = store.readActions(id);
      expect(actions).toHaveLength(3);
      expect(actions[0].tool).toBe('navigate');
      expect(actions[1].tool).toBe('read_page');
      expect(actions[2].tool).toBe('interact');
      expect(actions[2].ok).toBe(false);
      expect(actions[2].error).toBe('Element not found');
    });
  });
});
