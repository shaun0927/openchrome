/// <reference types="jest" />

/**
 * Unit tests for the stealth Runtime.enable audit guard.
 *
 * Honest scope: the guard does NOT shield the renderer-side Runtime.enable
 * leak. It provides a single choke point, refuse-by-default in stealth,
 * paired disable, and audit counters. Tests assert exactly that.
 */

import { EventEmitter } from 'events';
import {
  ensureRuntimeEnabled,
  disableRuntime,
  getGuardStats,
  RuntimeEnableRefusedError,
  __resetGuardStatsForTest,
} from '../../src/stealth/runtime-enable-guard';

interface FakeCDPSession extends EventEmitter {
  sent: string[];
  send(method: string): Promise<unknown>;
}

function makeFakeSession(): FakeCDPSession {
  const emitter = new EventEmitter() as FakeCDPSession;
  emitter.sent = [];
  emitter.send = jest.fn(async (method: string) => {
    emitter.sent.push(method);
    return {};
  });
  return emitter;
}

beforeEach(() => __resetGuardStatsForTest());

describe('ensureRuntimeEnabled', () => {
  test('non-stealth targets always enable Runtime (passthrough)', async () => {
    const session = makeFakeSession();
    await ensureRuntimeEnabled(session as never, { isStealthTarget: false, callerId: 'test' });
    expect(session.sent).toEqual(['Runtime.enable']);
    expect(getGuardStats().enableCalls).toBe(1);
    expect(getGuardStats().byCaller.test.enables).toBe(1);
  });

  test('stealth targets refuse by default (no Runtime.enable is sent)', async () => {
    const session = makeFakeSession();
    await expect(
      ensureRuntimeEnabled(session as never, { isStealthTarget: true, callerId: 'console_capture' }),
    ).rejects.toBeInstanceOf(RuntimeEnableRefusedError);
    expect(session.sent).toEqual([]);
    expect(getGuardStats().refusals).toBe(1);
    expect(getGuardStats().byCaller.console_capture.refusals).toBe(1);
  });

  test('stealth mode=allow sends Runtime.enable and records the audit event', async () => {
    const session = makeFakeSession();
    await ensureRuntimeEnabled(session as never, {
      isStealthTarget: true,
      stealthMode: 'allow',
      callerId: 'validate_page',
    });
    expect(session.sent).toEqual(['Runtime.enable']);
    expect(getGuardStats().enableCalls).toBe(1);
    expect(getGuardStats().byCaller.validate_page.enables).toBe(1);
  });

  test('RuntimeEnableRefusedError names the caller and states no shield is provided', () => {
    const err = new RuntimeEnableRefusedError('validate_page');
    expect(err.message).toContain('validate_page');
    expect(err.message).toContain('does not shield');
    expect(err.code).toBe('runtime_enable_refused');
  });
});

describe('disableRuntime', () => {
  test('sends Runtime.disable and increments audit counter', async () => {
    const session = makeFakeSession();
    await disableRuntime(session as never, { callerId: 'console_capture' });
    expect(session.sent).toEqual(['Runtime.disable']);
    expect(getGuardStats().disableCalls).toBe(1);
    expect(getGuardStats().byCaller.console_capture.disables).toBe(1);
  });

  test('swallows send errors so cleanup paths never throw', async () => {
    const session = makeFakeSession();
    (session.send as jest.Mock).mockRejectedValueOnce(new Error('detached'));
    await expect(disableRuntime(session as never, { callerId: 'x' })).resolves.toBeUndefined();
    // No disable counted because send failed.
    expect(getGuardStats().disableCalls).toBe(0);
  });
});

describe('audit counters', () => {
  test('each enable is expected to be paired with a disable', async () => {
    const session = makeFakeSession();
    await ensureRuntimeEnabled(session as never, {
      isStealthTarget: true, stealthMode: 'allow', callerId: 'console_capture',
    });
    await disableRuntime(session as never, { callerId: 'console_capture' });
    const s = getGuardStats();
    expect(s.enableCalls).toBe(s.disableCalls);
    expect(s.byCaller.console_capture.enables).toBe(s.byCaller.console_capture.disables);
  });

  test('__resetGuardStatsForTest clears all counters', async () => {
    const session = makeFakeSession();
    await ensureRuntimeEnabled(session as never, { isStealthTarget: false, callerId: 't' });
    __resetGuardStatsForTest();
    const s = getGuardStats();
    expect(s.enableCalls).toBe(0);
    expect(s.byCaller).toEqual({});
  });
});
