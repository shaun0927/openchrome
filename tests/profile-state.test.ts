/// <reference types="jest" />
/**
 * Tests for ChromeLauncher ProfileState tracking
 */

beforeEach(() => {
  jest.resetModules();
});

describe('ChromeLauncher ProfileState', () => {
  test('ChromeLauncher class is exported and instantiable', async () => {
    const launcher = await import('../src/chrome/launcher');
    expect(launcher.ChromeLauncher).toBeDefined();
  });

  test('getProfileState method exists on ChromeLauncher instance', () => {
    const { ChromeLauncher } = jest.requireActual('../src/chrome/launcher') as typeof import('../src/chrome/launcher');
    const instance = new ChromeLauncher(9222);
    expect(typeof instance.getProfileState).toBe('function');
  });

  test('default profile state is real with extensions', () => {
    const { ChromeLauncher } = jest.requireActual('../src/chrome/launcher') as typeof import('../src/chrome/launcher');
    const instance = new ChromeLauncher(9222);
    const state = instance.getProfileState();
    expect(state.type).toBe('real');
    expect(state.extensionsAvailable).toBe(true);
    expect(state.cookieCopiedAt).toBeUndefined();
    expect(state.sourceProfile).toBeUndefined();
  });

  test('getProfileState returns a copy (not reference)', () => {
    const { ChromeLauncher } = jest.requireActual('../src/chrome/launcher') as typeof import('../src/chrome/launcher');
    const instance = new ChromeLauncher(9222);
    const state1 = instance.getProfileState();
    const state2 = instance.getProfileState();
    expect(state1).toEqual(state2);
    expect(state1).not.toBe(state2);
  });

  test('ProfileType union includes all expected values', () => {
    const { ChromeLauncher } = jest.requireActual('../src/chrome/launcher') as typeof import('../src/chrome/launcher');
    const instance = new ChromeLauncher(9222);
    const state = instance.getProfileState();
    const validTypes = ['real', 'temp-snapshot', 'temp-fresh'];
    expect(validTypes).toContain(state.type);
  });

  test('default profileState has no userDataDir', () => {
    const { ChromeLauncher } = jest.requireActual('../src/chrome/launcher') as typeof import('../src/chrome/launcher');
    const instance = new ChromeLauncher(9222);
    const state = instance.getProfileState();
    expect(state.userDataDir).toBeUndefined();
  });

  test('multiple instances have independent profile states', () => {
    const { ChromeLauncher } = jest.requireActual('../src/chrome/launcher') as typeof import('../src/chrome/launcher');
    const instance1 = new ChromeLauncher(9222);
    const instance2 = new ChromeLauncher(9223);
    const state1 = instance1.getProfileState();
    const state2 = instance2.getProfileState();
    expect(state1.type).toBe('real');
    expect(state2.type).toBe('real');
    expect(state1).not.toBe(state2);
  });

  test('getChromeLauncher returns an instance with getProfileState', () => {
    const { getChromeLauncher } = jest.requireActual('../src/chrome/launcher') as typeof import('../src/chrome/launcher');
    const launcher = getChromeLauncher(9299);
    expect(typeof launcher.getProfileState).toBe('function');
    const state = launcher.getProfileState();
    expect(state.type).toBe('real');
    expect(state.extensionsAvailable).toBe(true);
  });
});
