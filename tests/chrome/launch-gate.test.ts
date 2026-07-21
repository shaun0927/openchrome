import {
  arm,
  armedAt,
  disarm,
  envLaunchOnFirstUse,
  isArmed,
  onFirstUse,
  resetLaunchGateForTests,
  resolveEffectiveAutoLaunch,
} from '../../src/chrome/launch-gate';

describe('launch gate (P3)', () => {
  const savedEnv = process.env.OPENCHROME_LAUNCH_ON_FIRST_USE;
  beforeEach(() => {
    delete process.env.OPENCHROME_LAUNCH_ON_FIRST_USE;
    resetLaunchGateForTests();
  });
  afterAll(() => {
    if (savedEnv === undefined) delete process.env.OPENCHROME_LAUNCH_ON_FIRST_USE;
    else process.env.OPENCHROME_LAUNCH_ON_FIRST_USE = savedEnv;
  });

  describe('arm / disarm / isArmed', () => {
    test('starts disarmed', () => {
      expect(isArmed()).toBe(false);
      expect(armedAt()).toBe(0);
    });
    test('arm() flips state and stamps time', () => {
      const before = Date.now();
      arm();
      expect(isArmed()).toBe(true);
      expect(armedAt()).toBeGreaterThanOrEqual(before);
    });
    test('arm() is idempotent (second call preserves original timestamp)', () => {
      arm();
      const first = armedAt();
      arm();
      expect(armedAt()).toBe(first);
    });
    test('disarm() reverts state', () => {
      arm();
      disarm();
      expect(isArmed()).toBe(false);
      expect(armedAt()).toBe(0);
    });
  });

  describe('resolveEffectiveAutoLaunch', () => {
    test('opt-in off + gate off → pass-through true', () => {
      expect(resolveEffectiveAutoLaunch(true)).toBe(true);
    });
    test('opt-in off + gate off → pass-through false', () => {
      expect(resolveEffectiveAutoLaunch(false)).toBe(false);
    });
    test('opt-in on + gate disarmed → coerce to false even when cfg=true', () => {
      expect(resolveEffectiveAutoLaunch(true, { launchOnFirstUse: true })).toBe(false);
    });
    test('opt-in on + gate armed → pass-through cfg', () => {
      arm();
      expect(resolveEffectiveAutoLaunch(true, { launchOnFirstUse: true })).toBe(true);
      expect(resolveEffectiveAutoLaunch(false, { launchOnFirstUse: true })).toBe(false);
    });
    test('env OPENCHROME_LAUNCH_ON_FIRST_USE=1 opts in without option', () => {
      process.env.OPENCHROME_LAUNCH_ON_FIRST_USE = '1';
      expect(resolveEffectiveAutoLaunch(true)).toBe(false);
      arm();
      expect(resolveEffectiveAutoLaunch(true)).toBe(true);
    });
    test('env falsy does not opt in', () => {
      process.env.OPENCHROME_LAUNCH_ON_FIRST_USE = 'no';
      expect(resolveEffectiveAutoLaunch(true)).toBe(true);
    });
  });

  describe('onFirstUse', () => {
    test('listener fires exactly once on arm()', () => {
      const fn = jest.fn();
      onFirstUse(fn);
      expect(fn).not.toHaveBeenCalled();
      arm();
      expect(fn).toHaveBeenCalledTimes(1);
      arm(); // idempotent
      expect(fn).toHaveBeenCalledTimes(1);
    });
    test('listener fires synchronously if gate already armed', () => {
      arm();
      const fn = jest.fn();
      onFirstUse(fn);
      expect(fn).toHaveBeenCalledTimes(1);
    });
    test('listener error does not corrupt subsequent listeners or state', () => {
      const err = jest.fn(() => { throw new Error('boom'); });
      const ok = jest.fn();
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      onFirstUse(err);
      onFirstUse(ok);
      arm();
      expect(err).toHaveBeenCalled();
      expect(ok).toHaveBeenCalled();
      expect(isArmed()).toBe(true);
      errSpy.mockRestore();
    });
    test('listeners are cleared after firing (no re-fire on disarm→arm)', () => {
      const fn = jest.fn();
      onFirstUse(fn);
      arm();
      disarm();
      arm();
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('envLaunchOnFirstUse', () => {
    test.each([
      ['1', true],
      ['true', true],
      ['TRUE', true],
      ['yes', true],
      ['on', true],
      ['0', false],
      ['false', false],
      ['', false],
    ])('env=%s → %s', (v, expected) => {
      process.env.OPENCHROME_LAUNCH_ON_FIRST_USE = v;
      expect(envLaunchOnFirstUse()).toBe(expected);
    });
    test('unset env → false', () => {
      expect(envLaunchOnFirstUse()).toBe(false);
    });
  });
});
