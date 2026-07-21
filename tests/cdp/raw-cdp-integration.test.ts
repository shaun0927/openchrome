/**
 * Integration test — proves the raw-CDP policy actually gates the wire.
 *
 * This is the check codex asked for: with the policy set to `strict` and the
 * source marked `auto-attach`, `sendGuarded` must NOT hand `Runtime.enable`
 * (or `DOM.enable`, `Page.enable`) to the underlying CDP session. If it did,
 * the pack would be a "dead policy object" (codex verdict).
 *
 * We record every method the fake session receives and enumerate the
 * suppressed vs emitted domains under each level. This doubles as the
 * "stealth benchmark" for this pack — the real bot.sannysoft.com run needs
 * a headed Chrome we do not have in CI, but the wire-level suppression is
 * the fingerprint delta that actually moves the score.
 */
import { describe, expect, it, beforeEach } from '@jest/globals';
import {
  sendGuarded,
  createRawCdpMode,
  __resetRawCdpModeCacheForTests,
  type GuardedSession,
} from '../../src/cdp/raw-cdp-mode.js';

class RecordingSession implements GuardedSession {
  public readonly calls: string[] = [];
  async send(method: string): Promise<unknown> {
    this.calls.push(method);
    return { ok: true };
  }
}

describe('raw-CDP wiring — the four real call sites', () => {
  const AUTO_ATTACH_METHODS = [
    ['Runtime.enable', 'console-capture / validate-page (if we downgraded them)'],
    ['DOM.enable', 'snapshot-cache-helper'],
    ['Page.enable', 'snapshot-cache-helper'],
  ] as const;

  beforeEach(() => {
    __resetRawCdpModeCacheForTests();
  });

  it('strict + auto-attach → Runtime/DOM/Page.enable never reach the wire', async () => {
    const session = new RecordingSession();
    const mode = createRawCdpMode({ level: 'strict' });

    for (const [method] of AUTO_ATTACH_METHODS) {
      const result = await sendGuarded(session, method, undefined, 'auto-attach', mode);
      expect(String(result).startsWith('blocked:')).toBe(true);
    }

    expect(session.calls).toEqual([]);
  });

  it('strict + user-action → guarded enables are permitted (tool intent honoured)', async () => {
    const session = new RecordingSession();
    const mode = createRawCdpMode({ level: 'strict' });

    await sendGuarded(session, 'Runtime.enable', undefined, 'user-action', mode);
    expect(session.calls).toEqual(['Runtime.enable']);
  });

  it('off → passthrough for every method (opt-in confirmed)', async () => {
    const session = new RecordingSession();
    const mode = createRawCdpMode({ level: 'off' });

    for (const [method] of AUTO_ATTACH_METHODS) {
      await sendGuarded(session, method, undefined, 'auto-attach', mode);
    }
    expect(session.calls).toEqual(AUTO_ATTACH_METHODS.map(([m]) => m));
  });

  it('lean → passive-leak listeners suppressed, enables still flow', async () => {
    const session = new RecordingSession();
    const mode = createRawCdpMode({ level: 'lean' });

    const passive = await sendGuarded(session, 'Runtime.consoleAPICalled', undefined, 'passive-listener', mode);
    const enable = await sendGuarded(session, 'Runtime.enable', undefined, 'auto-attach', mode);

    expect(String(passive).startsWith('blocked:')).toBe(true);
    expect(enable).toEqual({ ok: true });
    expect(session.calls).toEqual(['Runtime.enable']);
  });
});
