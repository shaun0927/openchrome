import { ActivityTracker } from '../../src/dashboard/activity-tracker';
import { HintEngine } from '../../src/hints/hint-engine';
import { TaskDriftLedgerStore, setTaskDriftLedger } from '../../src/harness/task-ledger';

function result(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('TaskDriftLedgerStore', () => {
  let store: TaskDriftLedgerStore;

  beforeEach(() => {
    store = new TaskDriftLedgerStore();
    setTaskDriftLedger(store);
  });

  test('records bounded attempts and detects repeated action drift', () => {
    for (let i = 0; i < 16; i++) {
      store.updateFromToolResult({
        sessionId: 's1',
        tabId: 't1',
        toolName: 'interact',
        args: { tabId: 't1', action: 'click', target: 'Checkout' },
        resultText: 'Error: element not found',
        isError: true,
        now: 1000 + i,
      });
    }

    const [ledger] = store.snapshot('s1');
    expect(ledger.recentAttempts).toHaveLength(12);
    expect(ledger.driftSignals).toContain('repeated_action');
    expect(ledger.driftSignals).toContain('same_error');
    expect(ledger.suggestedNextStep?.reason).toContain('same action');
  });

  test('read-only observations do not reset prior non-progress drift', () => {
    store.updateFromToolResult({ sessionId: 's1', tabId: 't1', toolName: 'interact', args: { tabId: 't1', action: 'click', target: 'Checkout' }, resultText: 'element not found', isError: true, now: 1 });
    store.updateFromToolResult({ sessionId: 's1', tabId: 't1', toolName: 'read_page', args: { tabId: 't1' }, resultText: 'page text', isError: false, now: 2 });
    store.updateFromToolResult({ sessionId: 's1', tabId: 't1', toolName: 'read_page', args: { tabId: 't1' }, resultText: 'page text', isError: false, now: 3 });
    store.updateFromToolResult({ sessionId: 's1', tabId: 't1', toolName: 'interact', args: { tabId: 't1', action: 'click', target: 'Checkout' }, resultText: 'element not found', isError: true, now: 4 });

    const [ledger] = store.snapshot('s1');
    expect(ledger.driftSignals).toContain('observation_loop');
  });

  test('records Ralph recovery attempts and cleans up session/tab state', () => {
    store.updateFromToolResult({ sessionId: 's1', tabId: 't1', toolName: 'interact', args: { tabId: 't1' }, resultText: 'stale ref', isError: true, now: 1 });
    store.recordRecovery('s1', { strategy: 'S3_CDP_COORD', outcome: 'failed', at: 2 }, 't1');

    expect(store.snapshot('s1')[0].triedRecoveries).toEqual([{ strategy: 'S3_CDP_COORD', outcome: 'failed', at: 2 }]);
    expect(store.cleanupTab('s1', 't1')).toBe(true);
    expect(store.snapshot('s1')).toHaveLength(0);

    store.updateFromToolResult({ sessionId: 's1', tabId: 't2', toolName: 'interact', args: { tabId: 't2' }, resultText: 'timeout', isError: true, now: 3 });
    expect(store.cleanupSession('s1')).toBe(1);
    expect(store.snapshot('s1')).toHaveLength(0);
  });
});

describe('HintEngine task ledger integration', () => {
  beforeEach(() => {
    setTaskDriftLedger(new TaskDriftLedgerStore());
  });

  test('includes concise ledger-derived hint when repeated action drift is detected', () => {
    const tracker = new ActivityTracker();
    const engine = new HintEngine(tracker);

    for (let i = 0; i < 3; i++) {
      const hint = engine.getHint(
        'interact',
        result('Error: element not found'),
        true,
        's1',
        { tabId: 't1', action: 'click', target: 'Checkout' },
      );
      if (i < 2) {
        const callId = tracker.startCall('interact', 's1', { tabId: 't1', action: 'click', target: 'Checkout' });
        tracker.endCall(callId, 'error', 'element not found');
      }
      if (i === 2) {
        expect(hint?.hint).toContain('Task ledger drift detected');
        expect(hint?.hint).toContain('repeated_action');
      }
    }
  });
});
