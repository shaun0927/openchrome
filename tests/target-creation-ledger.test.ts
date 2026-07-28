import {
  TargetCreationLedger,
  sanitizeTargetTitle,
  sanitizeTargetUrl,
} from '../src/session/target-creation-ledger';

describe('TargetCreationLedger', () => {
  test('reports only ready children created after the cursor in deterministic order', () => {
    const ledger = new TargetCreationLedger();
    ledger.register({
      targetId: 'before', sessionId: 's1', workerId: 'w1', openerTargetId: 'parent',
      state: 'ready', url: 'https://example.com/before', createdAt: 1,
    });
    const cursor = ledger.getCursor();
    ledger.register({
      targetId: 'first', sessionId: 's1', workerId: 'w1', openerTargetId: 'parent',
      state: 'provisional', createdAt: 2,
    });
    ledger.register({
      targetId: 'second', sessionId: 's1', workerId: 'w1', openerTargetId: 'parent',
      state: 'ready', url: 'https://example.com/second', title: 'Second', createdAt: 3,
    });
    ledger.markReady('first', { url: 'https://example.com/first', title: 'First' }, 4);

    const result = ledger.query({
      afterSequence: cursor,
      sessionId: 's1',
      workerId: 'w1',
      openerTargetId: 'parent',
      limit: 5,
    });

    expect(result.total).toBe(2);
    expect(result.pendingCount).toBe(0);
    expect(result.tabs.map((tab) => tab.tabId)).toEqual(['first', 'second']);
  });

  test('keeps ready-then-closed facts but excludes provisional-closed and blocked targets', () => {
    const ledger = new TargetCreationLedger();
    const cursor = ledger.getCursor();

    ledger.register({ targetId: 'ready', sessionId: 's1', workerId: 'w1', openerTargetId: 'parent', state: 'ready', url: 'https://example.com' });
    ledger.markClosed('ready');
    ledger.register({ targetId: 'blank', sessionId: 's1', workerId: 'w1', openerTargetId: 'parent', state: 'provisional' });
    ledger.markClosed('blank');
    ledger.register({ targetId: 'blocked', sessionId: 's1', workerId: 'w1', openerTargetId: 'parent', state: 'ready', url: 'https://allowed.example' });
    ledger.markBlocked('blocked');

    const result = ledger.query({ afterSequence: cursor, sessionId: 's1', workerId: 'w1', openerTargetId: 'parent' });
    expect(result.tabs).toEqual([{
      tabId: 'ready', workerId: 'w1', url: 'https://example.com/', title: '', status: 'closed',
    }]);
  });

  test('does not expose ready metadata until ownership registration commits', () => {
    const ledger = new TargetCreationLedger();
    const cursor = ledger.getCursor();
    ledger.register({
      targetId: 'child',
      sessionId: 's1',
      workerId: 'w1',
      openerTargetId: 'parent',
      state: 'ready',
      url: 'https://example.com/child',
      ownershipCommitted: false,
    });

    expect(ledger.query({ afterSequence: cursor, sessionId: 's1', workerId: 'w1', openerTargetId: 'parent' })).toMatchObject({
      total: 0,
      pendingCount: 1,
    });

    expect(ledger.markOwnershipCommitted('child')).toBe(true);
    expect(ledger.query({ afterSequence: cursor, sessionId: 's1', workerId: 'w1', openerTargetId: 'parent' }).total).toBe(1);
  });

  test('filters exact session, worker, and opener and caps details at five', () => {
    const ledger = new TargetCreationLedger();
    const cursor = ledger.getCursor();
    for (let i = 0; i < 7; i++) {
      ledger.register({
        targetId: `child-${i}`,
        sessionId: 's1',
        workerId: 'w1',
        openerTargetId: 'parent',
        state: 'ready',
        url: `https://example.com/${i}`,
      });
    }
    ledger.register({ targetId: 'other-worker', sessionId: 's1', workerId: 'w2', openerTargetId: 'parent', state: 'ready', url: 'https://example.com/w2' });
    ledger.register({ targetId: 'other-session', sessionId: 's2', workerId: 'w1', openerTargetId: 'parent', state: 'ready', url: 'https://example.com/s2' });
    ledger.register({ targetId: 'other-opener', sessionId: 's1', workerId: 'w1', openerTargetId: 'other', state: 'ready', url: 'https://example.com/other' });

    const result = ledger.query({ afterSequence: cursor, sessionId: 's1', workerId: 'w1', openerTargetId: 'parent', limit: 5 });
    expect(result.total).toBe(7);
    expect(result.truncated).toBe(true);
    expect(result.tabs.map((tab) => tab.tabId)).toEqual(['child-0', 'child-1', 'child-2', 'child-3', 'child-4']);
  });

  test('sanitizes credentials, fragments, control characters, and output length', () => {
    expect(sanitizeTargetUrl('https://user:secret@example.com/path?q=1#token')).toBe('https://example.com/path?q=1');
    expect(sanitizeTargetTitle('  Hello\n\u0000World  ')).toBe('Hello World');
    expect(sanitizeTargetTitle('x'.repeat(500))).toHaveLength(200);
  });

  test('remaps child IDs and opener aliases without changing creation provenance', () => {
    const ledger = new TargetCreationLedger();
    const cursor = ledger.getCursor();
    ledger.register({
      targetId: 'child-old', sessionId: 's1', workerId: 'w1', openerTargetId: 'parent-old',
      state: 'ready', url: 'https://example.com',
    });

    expect(ledger.remapTargetId('parent-old', 'parent-new')).toBe(true);
    expect(ledger.remapTargetId('child-old', 'child-new')).toBe(true);
    expect(ledger.get('child-new')).toMatchObject({
      openerTargetId: 'parent-old',
      currentOpenerTargetId: 'parent-new',
    });
    expect(ledger.query({ afterSequence: cursor, sessionId: 's1', workerId: 'w1', openerTargetId: 'parent-new' }).tabs[0].tabId).toBe('child-new');
  });

  test('clears session/worker state and remains bounded', () => {
    const ledger = new TargetCreationLedger(3);
    ledger.register({ targetId: 'a', sessionId: 's1', workerId: 'w1', openerTargetId: 'p', state: 'blocked' });
    ledger.register({ targetId: 'b', sessionId: 's1', workerId: 'w1', openerTargetId: 'p', state: 'provisional' });
    ledger.markClosed('b');
    ledger.register({ targetId: 'c', sessionId: 's1', workerId: 'w2', openerTargetId: 'p', state: 'ready', url: 'https://example.com/c' });
    ledger.register({ targetId: 'd', sessionId: 's2', workerId: 'w1', openerTargetId: 'p', state: 'ready', url: 'https://example.com/d' });
    expect(ledger.size).toBe(3);

    ledger.clearWorker('s1', 'w2');
    expect(ledger.get('c')).toBeUndefined();
    ledger.clearSession('s2');
    expect(ledger.get('d')).toBeUndefined();
  });
});
