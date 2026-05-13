/** Tests for default-off trajectory bundle integration (#1059). */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ActionRecorder } from '../../src/recording/action-recorder';
import { RecordingStore } from '../../src/recording/recording-store';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function jsonl(file: string): any[] {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('ActionRecorder trajectory bundle', () => {
  let recordingDir: string;
  let trajectoryRoot: string;
  let recorder: ActionRecorder;

  beforeEach(() => {
    recordingDir = tmp('oc-rec-traj-recording-');
    trajectoryRoot = tmp('oc-rec-traj-root-');
    recorder = new ActionRecorder(new RecordingStore(recordingDir), { captureScreenshots: false });
  });

  afterEach(() => {
    fs.rmSync(recordingDir, { recursive: true, force: true });
    fs.rmSync(trajectoryRoot, { recursive: true, force: true });
  });

  it('is default-off when recording starts without trajectoryBundle', async () => {
    await recorder.start('sess-default');
    await recorder.recordAction('navigate', { url: 'https://example.com' }, 10, true);
    await recorder.stop();

    expect(fs.readdirSync(trajectoryRoot)).toEqual([]);
  });

  it('writes ordered events, redacted summaries, contract artifact, checkpoint artifact, and report', async () => {
    const metadata = await recorder.start('sess-traj', { trajectoryBundle: true, trajectoryRootDir: trajectoryRoot });
    expect(metadata.trajectoryBundle?.enabled).toBe(true);
    const bundle = recorder.activeTrajectoryBundle!;

    await recorder.recordAction('form_input', { username: 'alice', password: 'super-secret-fixture-password' }, 25, true, { url: 'https://example.com/login' });
    await recorder.appendContractResult({ assertion: { kind: 'dom_text', secret: 'super-secret-fixture-password' }, verdict: 'fail', details: { token: 'super-secret-fixture-password', reason: 'missing text' } });
    await recorder.appendCheckpoint({ taskDescription: 'demo', completedSteps: ['open'], pendingSteps: ['assert'], extractedData: { apiKey: 'super-secret-fixture-password' } });
    const stopped = await recorder.stop();

    const events = jsonl(path.join(bundle.dir, 'events.jsonl'));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[0].event).toBe('tool_call_end');
    expect(events[1].event).toBe('contract');
    expect(events[2].event).toBe('checkpoint');
    expect(JSON.stringify(events)).not.toContain('super-secret-fixture-password');

    const report = JSON.parse(fs.readFileSync(path.join(bundle.dir, 'report.json'), 'utf8'));
    expect(report.tool_calls).toBe(1);
    expect(report.contracts.fail).toBe(1);
    expect(report.artifacts.checkpoints).toBe(1);
    expect(report.artifacts.contracts).toBe(1);
    expect(stopped.trajectoryBundle?.report).toBeDefined();

    expect(fs.readdirSync(path.join(bundle.dir, 'contracts'))).toHaveLength(1);
    expect(fs.readdirSync(path.join(bundle.dir, 'checkpoints'))).toHaveLength(1);
    expect(fs.readFileSync(path.join(bundle.dir, 'contracts', '000002.json'), 'utf8')).not.toContain('super-secret-fixture-password');
    expect(fs.readFileSync(path.join(bundle.dir, 'checkpoints', '000003.json'), 'utf8')).not.toContain('super-secret-fixture-password');
  });
});
