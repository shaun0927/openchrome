/**
 * Tests for HandoffManager (Phase 3, issue #793).
 *
 * All tests drive a fake clock via the `now` option so they never sleep.
 * The prune timer is disabled (`pruneIntervalMs: 0`) except in the
 * stopPrune test which exercises the live timer path.
 */

import { HandoffManager } from '../../../src/pilot/handoff/manager.js';
import { HANDOFF_TOKEN_LENGTH } from '../../../src/pilot/handoff/token.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(nowMs = 1_000_000) {
  let clock = nowMs;
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const manager = new HandoffManager({ pruneIntervalMs: 0, now });
  return { manager, now, advance };
}

// ---------------------------------------------------------------------------
// Create + redeem round-trip
// ---------------------------------------------------------------------------

describe('HandoffManager — create + redeem round-trip', () => {
  it('register returns a base64url token with correct length', () => {
    const { manager } = makeManager();
    const result = manager.register({ sessionId: 'sess-1', scope: 'checkout' });
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBe(HANDOFF_TOKEN_LENGTH);
    expect(/^[A-Za-z0-9_-]+$/.test(result.token)).toBe(true);
    manager.dispose();
  });

  it('redeem returns the payload for a valid token', () => {
    const { manager } = makeManager();
    const { token } = manager.register({ sessionId: 'sess-2', scope: 'read-only' });
    const redemption = manager.redeem(token);
    expect(redemption).not.toBeNull();
    expect(redemption!.sessionId).toBe('sess-2');
    expect(redemption!.scope).toBe('read-only');
    expect(typeof redemption!.expiresAt).toBe('number');
    expect(typeof redemption!.createdAt).toBe('number');
    expect(typeof redemption!.redeemedAt).toBe('number');
    manager.dispose();
  });

  it('redeem is single-use — second call returns null', () => {
    const { manager } = makeManager();
    const { token } = manager.register({ sessionId: 'sess-3', scope: 'write' });
    expect(manager.redeem(token)).not.toBeNull();
    expect(manager.redeem(token)).toBeNull();
    manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// Wrong token returns null
// ---------------------------------------------------------------------------

describe('HandoffManager — wrong token returns null', () => {
  it('returns null for an unknown token string', () => {
    const { manager } = makeManager();
    manager.register({ sessionId: 'sess-4', scope: 'admin' });
    expect(manager.redeem('this-is-not-a-real-token')).toBeNull();
    manager.dispose();
  });

  it('returns null for an empty string', () => {
    const { manager } = makeManager();
    expect(manager.redeem('')).toBeNull();
    manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// Revoke removes
// ---------------------------------------------------------------------------

describe('HandoffManager — revoke', () => {
  it('revoke returns true and the token can no longer be redeemed', () => {
    const { manager } = makeManager();
    const { token } = manager.register({ sessionId: 'sess-5', scope: 'checkout' });
    expect(manager.revoke(token)).toBe(true);
    expect(manager.redeem(token)).toBeNull();
    manager.dispose();
  });

  it('revoke on unknown token returns false', () => {
    const { manager } = makeManager();
    expect(manager.revoke('not-a-real-token')).toBe(false);
    manager.dispose();
  });

  it('revoke decrements size', () => {
    const { manager } = makeManager();
    const { token } = manager.register({ sessionId: 'sess-6', scope: 'x' });
    expect(manager.size()).toBe(1);
    manager.revoke(token);
    expect(manager.size()).toBe(0);
    manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// TTL expiry returns null
// ---------------------------------------------------------------------------

describe('HandoffManager — TTL expiry', () => {
  it('redeem returns null after the token expires', () => {
    const { manager, advance } = makeManager();
    const { token } = manager.register({
      sessionId: 'sess-7',
      scope: 'short-lived',
      ttlMs: 500,
    });
    advance(501);
    expect(manager.redeem(token)).toBeNull();
    manager.dispose();
  });

  it('redeem succeeds just before expiry', () => {
    const { manager, advance } = makeManager();
    const { token } = manager.register({
      sessionId: 'sess-8',
      scope: 'just-in-time',
      ttlMs: 1000,
    });
    advance(999);
    expect(manager.redeem(token)).not.toBeNull();
    manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// pruneExpired returns count
// ---------------------------------------------------------------------------

describe('HandoffManager — pruneExpired', () => {
  it('returns 0 when nothing has expired', () => {
    const { manager } = makeManager();
    manager.register({ sessionId: 'sess-9', scope: 'a', ttlMs: 10_000 });
    manager.register({ sessionId: 'sess-10', scope: 'b', ttlMs: 10_000 });
    expect(manager.pruneExpired()).toBe(0);
    manager.dispose();
  });

  it('returns count of expired records and removes them', () => {
    const { manager, advance } = makeManager();
    manager.register({ sessionId: 'sess-11', scope: 'a', ttlMs: 100 });
    manager.register({ sessionId: 'sess-12', scope: 'b', ttlMs: 100 });
    manager.register({ sessionId: 'sess-13', scope: 'c', ttlMs: 10_000 });
    advance(200);
    const pruned = manager.pruneExpired();
    expect(pruned).toBe(2);
    expect(manager.size()).toBe(1);
    manager.dispose();
  });

  it('expired records cannot be redeemed after pruneExpired', () => {
    const { manager, advance } = makeManager();
    const { token } = manager.register({ sessionId: 'sess-14', scope: 'x', ttlMs: 50 });
    advance(100);
    manager.pruneExpired();
    expect(manager.redeem(token)).toBeNull();
    manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// stopPrune cancels the timer
// ---------------------------------------------------------------------------

describe('HandoffManager — stopPrune', () => {
  it('stopPrune returns true when a timer is running and cancels it', () => {
    // Use a real short interval so we can verify the timer was created.
    let clock = 1_000_000;
    const manager = new HandoffManager({
      pruneIntervalMs: 60_000,
      now: () => clock,
    });
    expect(manager.stopPrune()).toBe(true);
    // A second call after the timer is already gone returns false.
    expect(manager.stopPrune()).toBe(false);
    manager.dispose();
  });

  it('stopPrune returns false when no timer was created (pruneIntervalMs: 0)', () => {
    const { manager } = makeManager();
    expect(manager.stopPrune()).toBe(false);
    manager.dispose();
  });
});
