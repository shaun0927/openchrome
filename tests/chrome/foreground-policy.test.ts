import { assertForegroundAllowed, ForegroundPolicyError } from '../../src/chrome/foreground-policy';

describe('explicit foreground policy', () => {
  const previous = process.env.OPENCHROME_FOCUS_POLICY;
  afterEach(() => {
    if (previous === undefined) delete process.env.OPENCHROME_FOCUS_POLICY;
    else process.env.OPENCHROME_FOCUS_POLICY = previous;
  });
  it('allows explicit activation by default', () => {
    delete process.env.OPENCHROME_FOCUS_POLICY;
    expect(() => assertForegroundAllowed()).not.toThrow();
  });
  it.each(['background-only', 'invalid-policy'])('refuses foreground for %s', value => {
    process.env.OPENCHROME_FOCUS_POLICY = value;
    expect(() => assertForegroundAllowed()).toThrow(ForegroundPolicyError);
  });
});
