import { ActivityTracker } from '../../src/dashboard/activity-tracker';
import { HintEngine } from '../../src/hints/hint-engine';
import { buildToolCallSignature, RepeatedCallDetector } from '../../src/hints/repeated-call-detector';

function result(text = 'ok'): Record<string, unknown> {
  return { content: [{ type: 'text', text }] };
}

function seedCall(
  tracker: ActivityTracker,
  toolName: string,
  sessionId: string,
  args?: Record<string, unknown>,
): string {
  const id = tracker.startCall(toolName, sessionId, args);
  tracker.endCall(id, 'success');
  return id;
}

describe('RepeatedCallDetector', () => {
  it('builds stable signatures independent of key order', () => {
    const a = buildToolCallSignature('find', { query: 'Submit', tabId: 'tab-1', sessionId: 's1' });
    const b = buildToolCallSignature('find', { sessionId: 's1', tabId: 'tab-1', query: 'Submit' });
    expect(a).toBe(b);
  });

  it('ignores volatile keys and redacts sensitive values in signatures', () => {
    const a = buildToolCallSignature('form_input', {
      tabId: 'tab-1',
      requestId: 'req-1',
      password: 'secret-a',
      value: 'visible',
    });
    const b = buildToolCallSignature('form_input', {
      tabId: 'tab-1',
      requestId: 'req-2',
      password: 'secret-b',
      value: 'visible',
    });
    expect(a).toBe(b);
    expect(a).not.toContain('secret-a');
    expect(a).not.toContain('secret-b');
  });

  it('warns on three consecutive identical calls', () => {
    const detector = new RepeatedCallDetector();
    const tracker = new ActivityTracker();
    const args = { query: 'missing button', tabId: 'tab-1' };
    seedCall(tracker, 'find', 's1', args);
    seedCall(tracker, 'find', 's1', args);

    const detection = detector.evaluate(tracker.getRecentCalls(5, 's1'), 'find', args);

    expect(detection?.severity).toBe('warning');
    expect(detection?.repeatedCount).toBe(3);
    expect(detection?.hint).toContain('Repeated identical tool call detected');
  });

  it('escalates to critical on five consecutive identical calls', () => {
    const detector = new RepeatedCallDetector();
    const tracker = new ActivityTracker();
    const args = { query: 'missing button', tabId: 'tab-1' };
    for (let i = 0; i < 4; i++) seedCall(tracker, 'find', 's1', args);

    const detection = detector.evaluate(tracker.getRecentCalls(5, 's1'), 'find', args);

    expect(detection?.severity).toBe('critical');
    expect(detection?.repeatedCount).toBe(5);
  });

  it('does not cross-contaminate sessions through HintEngine recent-call filtering', () => {
    const tracker = new ActivityTracker();
    const args = { query: 'Submit', tabId: 'tab-1' };
    seedCall(tracker, 'find', 's1', args);
    seedCall(tracker, 'find', 's1', args);
    seedCall(tracker, 'find', 's2', args);

    const engine = new HintEngine(tracker);
    const hintS2 = engine.getHint('find', result('1 result'), false, 's2', args);

    expect(hintS2?.rule).not.toBe('repeated-identical-tool-call');
  });

  it('filters the current completed call by id so production history does not double-count it', () => {
    const tracker = new ActivityTracker();
    const args = { query: 'Submit', tabId: 'tab-1' };
    seedCall(tracker, 'find', 's1', args);
    const currentCallId = seedCall(tracker, 'find', 's1', args);

    const engine = new HintEngine(tracker);
    const hint = engine.getHint('find', result('1 result'), false, 's1', args, currentCallId);

    expect(hint?.rule).not.toBe('repeated-identical-tool-call');
  });

  it('resets when the recent previous call has a different signature', () => {
    const tracker = new ActivityTracker();
    seedCall(tracker, 'find', 's1', { query: 'Submit', tabId: 'tab-1' });
    seedCall(tracker, 'find', 's1', { query: 'Submit', tabId: 'tab-1' });
    seedCall(tracker, 'find', 's1', { query: 'Cancel', tabId: 'tab-1' });

    const detector = new RepeatedCallDetector();
    const detection = detector.evaluate(tracker.getRecentCalls(5, 's1'), 'find', { query: 'Submit', tabId: 'tab-1' });

    expect(detection).toBeNull();
  });
});
