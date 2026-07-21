/// <reference types="jest" />

/**
 * Unit tests for the stealth Runtime.enable leak guard.
 * Origin idiom: patchright (Apache-2.0). Clean-room implementation.
 */

import { EventEmitter } from 'events';
import {
  ensureRuntimeEnabled,
  installRuntimeHookHiding,
  isStealthArtefactEvent,
  payloadMatchesArtefact,
  RuntimeEnableRefusedError,
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

describe('ensureRuntimeEnabled', () => {
  test('non-stealth targets always enable Runtime (passthrough)', async () => {
    const session = makeFakeSession();
    await ensureRuntimeEnabled(session as never, {
      isStealthTarget: false,
      callerId: 'test',
    });
    expect(session.sent).toEqual(['Runtime.enable']);
  });

  test('stealth targets refuse by default', async () => {
    const session = makeFakeSession();
    await expect(
      ensureRuntimeEnabled(session as never, {
        isStealthTarget: true,
        callerId: 'console_capture',
      }),
    ).rejects.toBeInstanceOf(RuntimeEnableRefusedError);
    // Runtime.enable must NOT have been sent when we refused.
    expect(session.sent).toEqual([]);
  });

  test('stealth mode=allow bypasses the shield', async () => {
    const session = makeFakeSession();
    await ensureRuntimeEnabled(session as never, {
      isStealthTarget: true,
      stealthMode: 'allow',
      callerId: 'test',
    });
    expect(session.sent).toEqual(['Runtime.enable']);
  });

  test('stealth mode=shield installs the filter BEFORE Runtime.enable', async () => {
    const session = makeFakeSession();
    // Prove ordering: the shield listener is attached before the send
    // resolves so it can see the very first consoleAPICalled event.
    (session.send as jest.Mock).mockImplementation(async (method: string) => {
      session.sent.push(method);
      // At the moment Runtime.enable is sent, the shield listener must
      // already be attached.
      expect(session.listenerCount('Runtime.consoleAPICalled')).toBeGreaterThan(0);
      return {};
    });
    await ensureRuntimeEnabled(session as never, {
      isStealthTarget: true,
      stealthMode: 'shield',
      callerId: 'test',
    });
    expect(session.sent).toEqual(['Runtime.enable']);
  });

  test('RuntimeEnableRefusedError names the caller for debuggability', () => {
    const err = new RuntimeEnableRefusedError('validate_page');
    expect(err.message).toContain('validate_page');
    expect(err.code).toBe('runtime_enable_refused');
  });
});

describe('installRuntimeHookHiding + payloadMatchesArtefact', () => {
  test('tags payloads that contain CDP artefact patterns', async () => {
    const session = makeFakeSession();
    await installRuntimeHookHiding(session as never);

    const event = {
      type: 'debug',
      args: [{ type: 'string', value: 'pptr:evaluate result' }],
    };
    session.emit('Runtime.consoleAPICalled', event);

    expect(isStealthArtefactEvent(event)).toBe(true);
  });

  test('leaves clean payloads untagged', async () => {
    const session = makeFakeSession();
    await installRuntimeHookHiding(session as never);

    const event = {
      type: 'log',
      args: [{ type: 'string', value: 'user log' }],
    };
    session.emit('Runtime.consoleAPICalled', event);

    expect(isStealthArtefactEvent(event)).toBe(false);
  });

  test('payloadMatchesArtefact matches known vendor fingerprints', () => {
    const patterns = ['__pptr__', 'evaluateOnNewDocument', 'DevTools'];
    expect(payloadMatchesArtefact({ x: '__pptr__ wrapper' }, patterns)).toBe(true);
    expect(payloadMatchesArtefact({ trace: 'at evaluateOnNewDocument' }, patterns)).toBe(true);
    expect(payloadMatchesArtefact({ msg: 'DevTools opened' }, patterns)).toBe(true);
    expect(payloadMatchesArtefact({ ok: 'user click' }, patterns)).toBe(false);
  });

  test('payloadMatchesArtefact tolerates unserialisable payloads', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(payloadMatchesArtefact(circular, ['x'])).toBe(false);
  });

  test('isStealthArtefactEvent guards nullish and non-object inputs', () => {
    expect(isStealthArtefactEvent(null)).toBe(false);
    expect(isStealthArtefactEvent(undefined)).toBe(false);
    expect(isStealthArtefactEvent(42)).toBe(false);
    expect(isStealthArtefactEvent('string')).toBe(false);
    expect(isStealthArtefactEvent({})).toBe(false);
  });
});
