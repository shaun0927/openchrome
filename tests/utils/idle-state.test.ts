/// <reference types="jest" />
import { createIdleState } from '../../src/utils/idle-state';

describe('createIdleState', () => {
  test('fresh instance is always idle (never-active → always idle)', () => {
    let clock = 1_000_000;
    const state = createIdleState({ now: () => clock });

    expect(state.isIdle(0)).toBe(true);
    expect(state.isIdle(1_000)).toBe(true);
    expect(state.isIdle(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(state.lastActiveAt()).toBe(0);
  });

  test('after notifyActive(), isIdle is false inside the window and true at/past it', () => {
    let clock = 1_000_000;
    const state = createIdleState({ now: () => clock });

    state.notifyActive(); // lastActive = 1_000_000
    expect(state.lastActiveAt()).toBe(1_000_000);

    // Still inside the 5-minute window → active
    clock = 1_000_000 + 4 * 60_000;
    expect(state.isIdle(5 * 60_000)).toBe(false);

    // Edge of the window → idle (formula: now - lastActive >= window)
    clock = 1_000_000 + 5 * 60_000;
    expect(state.isIdle(5 * 60_000)).toBe(true);

    // Well past the window → idle
    clock = 1_000_000 + 10 * 60_000;
    expect(state.isIdle(5 * 60_000)).toBe(true);
  });

  test('multiple rapid notifyActive() calls collapse to the most recent timestamp', () => {
    let clock = 1_000_000;
    const state = createIdleState({ now: () => clock });

    state.notifyActive(); // lastActive = 1_000_000

    // Wait past the window — now idle.
    clock = 1_000_000 + 6 * 60_000;
    expect(state.isIdle(5 * 60_000)).toBe(true);

    // A fresh notifyActive() must reset isIdle to false even though the
    // previous window had already elapsed.
    state.notifyActive(); // lastActive = 1_360_000
    expect(state.isIdle(5 * 60_000)).toBe(false);
    expect(state.lastActiveAt()).toBe(1_360_000);
  });

  test('isIdle(0) is true immediately after notifyActive() (documented contract)', () => {
    // This is the guard against "operator passes 0 thinking it disables":
    // 0 means "fire immediately", not "disable". Callers that want disabled
    // must omit the flag entirely.
    let clock = 42;
    const state = createIdleState({ now: () => clock });

    state.notifyActive();
    expect(state.isIdle(0)).toBe(true);
    // Also true right after advancing time 0ms — same tick.
    expect(state.isIdle(0)).toBe(true);
  });

  test('uses Date.now by default when no clock is injected', () => {
    const state = createIdleState();
    const before = Date.now();
    state.notifyActive();
    const after = Date.now();
    expect(state.lastActiveAt()).toBeGreaterThanOrEqual(before);
    expect(state.lastActiveAt()).toBeLessThanOrEqual(after);
  });
});
