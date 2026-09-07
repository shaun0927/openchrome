import { BrowserOperations } from '../../src/core/browser-operations';
import { runToolAttempt, assertToolAttemptActive, runWithCommandScope, trackAttemptCommand, drainAttemptCommands } from '../../src/core/deadline/tool-attempt';

describe('browser input ownership', () => {
  it('drains actual work before human grant and preserves independent target execution', () => {
    const operations = new BrowserOperations();
    const finish = operations.begin('s', ['a'], 'interact', true);
    const handoff = operations.pause('s', 'a');
    expect(handoff.phase).toBe('draining');
    expect(() => operations.begin('s', ['a'], 'interact', true)).toThrow('HUMAN_CONTROL_PENDING');
    expect(() => operations.begin('s', [], 'javascript_tool', true)).toThrow('HUMAN_CONTROL_PENDING');
    operations.begin('s', ['b'], 'interact', true)(true);
    expect(() => operations.resume('s', 'a', handoff.lease!)).toThrow('still draining');
    finish(true);
    expect(operations.status('s', 'a').phase).toBe('human');
    expect(() => operations.resume('s', 'a', 'wrong')).toThrow('Invalid');
    operations.resume('s', 'a', handoff.lease!);
    expect(operations.status('s', 'a').phase).toBe('automation');
  });

  it('does not treat a caller timeout as a drained browser command', async () => {
    jest.useFakeTimers();
    try {
      const operations = new BrowserOperations();
      let settle!: () => void;
      const command = new Promise<void>(resolve => { settle = resolve; });
      const result = runToolAttempt(async () => {
        const finish = operations.begin('s', ['a'], 'interact', true);
        await command;
        finish(true);
      }, Date.now() + 10);
      const rejected = expect(result).rejects.toMatchObject({ code: 'TOOL_DEADLINE', execution: 'unknown' });
      await jest.advanceTimersByTimeAsync(10);
      await rejected;
      expect(operations.pause('s', 'a').phase).toBe('draining');
      settle();
      await jest.advanceTimersByTimeAsync(0);
      expect(operations.status('s', 'a').phase).toBe('human');
    } finally { jest.useRealTimers(); }
  });

  it('propagates cancellation to nested execution and prevents later CDP admission', async () => {
    const controller = new AbortController();
    let continueWork!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const afterWait = new Promise<void>(resolve => { continueWork = resolve; });
    let writes = 0;
    let blocked = false;
    const work = runToolAttempt(async () => {
      started();
      await afterWait;
      try { assertToolAttemptActive(); writes++; } catch { blocked = true; }
    }, Date.now() + 1000, controller.signal);
    const rejected = expect(work).rejects.toMatchObject({ execution: 'unknown' });
    await ready;
    controller.abort();
    await rejected;
    continueWork();
    await new Promise(resolve => setImmediate(resolve));
    expect(writes).toBe(0);
    expect(blocked).toBe(true);
  });

  it('never dispatches a pre-cancelled operation', async () => {
    const controller = new AbortController(); controller.abort();
    const action = jest.fn();
    await expect(runToolAttempt(action, Date.now() + 1000, controller.signal)).rejects.toMatchObject({ execution: 'not_started' });
    expect(action).not.toHaveBeenCalled();
  });
});


test('bounded history never evicts running work and capacity refusal precedes dispatch', () => {
  const operations = new BrowserOperations();
  const finishes = Array.from({ length: 256 }, () => operations.begin('s', ['a'], 'write', true));
  expect(() => operations.begin('s', ['a'], 'write', true)).toThrow('OPERATION_CAPACITY');
  const lease = operations.pause('s', 'a');
  expect(operations.hasHandoff('s')).toBe(true);
  for (const finish of finishes.slice(0, 255)) finish(true);
  expect(operations.status('s', 'a').pendingWrites).toBe(1);
  expect(() => operations.resume('s', 'a', lease.lease!)).toThrow();
  finishes[255](true);
  operations.resume('s', 'a', lease.lease!);
  expect(operations.hasHandoff('s')).toBe(false);
});


test('nested command drains do not await a parent command that needs the child to return', async () => {
  let release!: () => void;
  await runToolAttempt(async () => runWithCommandScope(async () => {
    trackAttemptCommand(new Promise<void>(resolve => { release = resolve; }));
    await runWithCommandScope(async () => { await drainAttemptCommands(); });
    release();
    await drainAttemptCommands();
  }), Date.now() + 1000);
});
