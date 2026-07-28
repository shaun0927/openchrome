/// <reference types="jest" />

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ActionRecorder,
  beginSessionRecorderDeletion,
  completeSessionRecorderDeletion,
  getOrCreateActionRecorder,
  unregisterSessionRecorder,
} from '../../src/recording/action-recorder';
import { RecordingStore } from '../../src/recording/recording-store';

describe('session-scoped ActionRecorder lifecycle', () => {
  afterEach(() => {
    completeSessionRecorderDeletion('session-a');
    completeSessionRecorderDeletion('session-b');
    unregisterSessionRecorder('session-a');
    unregisterSessionRecorder('session-b');
  });

  it('returns one stable recorder per session and distinct recorders across sessions', () => {
    const firstA = getOrCreateActionRecorder('session-a');
    const secondA = getOrCreateActionRecorder('session-a');
    const firstB = getOrCreateActionRecorder('session-b');

    expect(secondA).toBe(firstA);
    expect(firstB).not.toBe(firstA);
  });

  it('creates a fresh recorder after the session registry entry is evicted', () => {
    const first = getOrCreateActionRecorder('session-a');
    unregisterSessionRecorder('session-a');

    expect(getOrCreateActionRecorder('session-a')).not.toBe(first);
  });

  it('blocks recorder recreation during deletion and permits session ID reuse afterward', () => {
    const first = getOrCreateActionRecorder('session-a');
    beginSessionRecorderDeletion('session-a');
    beginSessionRecorderDeletion('session-a');

    expect(() => getOrCreateActionRecorder('session-a')).toThrow('being deleted');

    completeSessionRecorderDeletion('session-a');
    expect(() => getOrCreateActionRecorder('session-a')).toThrow('being deleted');

    completeSessionRecorderDeletion('session-a');
    expect(getOrCreateActionRecorder('session-a')).not.toBe(first);
  });

  it('serializes concurrent starts so exactly one recording becomes active', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recorder-lifecycle-'));
    const store = new RecordingStore(dir);
    const recorder = new ActionRecorder(store, { captureScreenshots: false });

    try {
      const outcomes = await Promise.allSettled([
        recorder.start('session-a'),
        recorder.start('session-a'),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      expect(await store.listRecordings()).toHaveLength(1);
      expect(recorder.isRecording).toBe(true);
    } finally {
      if (recorder.isRecording) await recorder.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finalizes before writes admitted after stop and keeps metadata consistent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recorder-stop-order-'));
    const store = new RecordingStore(dir);
    const recorder = new ActionRecorder(store, { captureScreenshots: false });
    const originalAppendAction = store.appendAction.bind(store);
    let markAppendStarted!: () => void;
    let releaseAppend!: () => void;
    const appendStarted = new Promise<void>((resolve) => { markAppendStarted = resolve; });
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });

    jest.spyOn(store, 'appendAction').mockImplementation(async (recordingId, action) => {
      if (action.tool === 'first') {
        markAppendStarted();
        await appendGate;
      }
      await originalAppendAction(recordingId, action);
    });

    try {
      await recorder.start('session-a');
      const recordingId = recorder.activeRecordingId!;
      const firstWrite = recorder.recordAction('first', {}, 10, true);
      await appendStarted;

      const stopping = recorder.stop();
      await Promise.resolve();
      const lateWrite = recorder.recordAction('late', {}, 10, true);
      releaseAppend();

      const [, metadata] = await Promise.all([firstWrite, stopping, lateWrite]);
      const persisted = await store.readMetadata(recordingId);

      expect(store.readActions(recordingId).map((action) => action.tool)).toEqual(['first']);
      expect(metadata.actionCount).toBe(1);
      expect(persisted?.actionCount).toBe(1);
      expect(recorder.isRecording).toBe(false);
    } finally {
      releaseAppend();
      if (recorder.isRecording) await recorder.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a stale recording generation after stop and restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recorder-generation-'));
    const store = new RecordingStore(dir);
    const recorder = new ActionRecorder(store, { captureScreenshots: false });

    try {
      const first = await recorder.start('session-a');
      await recorder.stop();
      const second = await recorder.start('session-a');

      await recorder.recordActionForRecording(first.id, 'stale', {}, 10, true);

      expect(store.readActions(second.id)).toHaveLength(0);
      expect(recorder.activeMetadata?.actionCount).toBe(0);
    } finally {
      if (recorder.isRecording) await recorder.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
