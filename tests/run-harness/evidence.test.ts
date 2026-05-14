/// <reference types="jest" />

import { RunEvidenceCapture, shouldAutoCaptureRunEvidence } from '../../src/run-harness/evidence';
import type { RunEvent, RunRecord } from '../../src/run-harness/types';

describe('RunEvidenceCapture', () => {
  test('builds graceful safe-mode bundle with omitted screenshot/network/console reasons', () => {
    const capture = new RunEvidenceCapture({ now: () => 1234, idFactory: () => 'x' });
    const record: RunRecord = { run_id: 'run-1', status: 'running', created_at: 1, updated_at: 2, events: [] };
    const event: RunEvent = { id: 'evt-1', run_id: 'run-1', ts: 2, kind: 'tool_call_finished', tool: 'wait_for', ok: false, metadata: { url: 'https://example.test' } };
    const bundle = capture.buildBundle({ record, event, trigger: 'tool_error' });
    expect(bundle.evidence_id).toBe('evidence-x');
    expect(bundle.trigger).toBe('tool_error');
    expect(bundle.metadata.screenshot.included).toBe(false);
    expect(bundle.metadata.network.included).toBe(false);
    expect(bundle.metadata.console.included).toBe(false);
  });

  test('identifies tool errors and stuck progress as capture triggers', () => {
    expect(shouldAutoCaptureRunEvidence({ id: '1', run_id: 'r', ts: 1, kind: 'tool_call_finished', ok: false })).toBe(true);
    expect(shouldAutoCaptureRunEvidence({ id: '2', run_id: 'r', ts: 1, kind: 'tool_call_finished', ok: true, metadata: { progress: { status: 'stuck' } } })).toBe(true);
    expect(shouldAutoCaptureRunEvidence({ id: '3', run_id: 'r', ts: 1, kind: 'tool_call_finished', ok: true })).toBe(false);
  });
});
