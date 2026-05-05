import {
  resolveLaunchMode,
  InvalidLaunchModeError,
  AttachConsentRequiredError,
} from '../../src/chrome/launch-mode-resolver';

describe('resolveLaunchMode (#659)', () => {
  it('default is auto', () => {
    expect(resolveLaunchMode({}, {}, {})).toBe('auto');
  });

  it('CLI option overrides everything', () => {
    expect(
      resolveLaunchMode(
        { launchMode: 'isolated' },
        { OPENCHROME_LAUNCH_MODE: 'attach' },
        { chromeLaunchMode: 'auto' },
      ),
    ).toBe('isolated');
  });

  it('env overrides config', () => {
    expect(
      resolveLaunchMode({}, { OPENCHROME_LAUNCH_MODE: 'attach' }, { chromeLaunchMode: 'isolated' }),
    ).toBe('attach');
  });

  it('config used when env unset', () => {
    expect(resolveLaunchMode({}, {}, { chromeLaunchMode: 'isolated' })).toBe('isolated');
  });

  it('case-insensitive parsing', () => {
    expect(resolveLaunchMode({}, { OPENCHROME_LAUNCH_MODE: 'ATTACH' }, {})).toBe('attach');
    expect(resolveLaunchMode({}, { OPENCHROME_LAUNCH_MODE: '  Isolated  ' }, {})).toBe('isolated');
  });

  it('whitespace / empty values fall through', () => {
    expect(resolveLaunchMode({}, { OPENCHROME_LAUNCH_MODE: '  ' }, {})).toBe('auto');
    expect(resolveLaunchMode({ launchMode: '' }, {}, {})).toBe('auto');
  });

  it('throws InvalidLaunchModeError on typo', () => {
    expect(() => resolveLaunchMode({}, { OPENCHROME_LAUNCH_MODE: 'attatch' }, {})).toThrow(InvalidLaunchModeError);
    expect(() => resolveLaunchMode({ launchMode: 'wrong' }, {}, {})).toThrow(InvalidLaunchModeError);
    expect(() => resolveLaunchMode({}, {}, { chromeLaunchMode: 'isolatd' })).toThrow(InvalidLaunchModeError);
  });

  it('error message identifies the source', () => {
    try {
      resolveLaunchMode({}, { OPENCHROME_LAUNCH_MODE: 'oops' }, {});
      fail('expected throw');
    } catch (err) {
      expect((err as Error).message).toContain('env');
    }
  });
});

describe('AttachConsentRequiredError', () => {
  it('embeds the port and a helpful hint', () => {
    const err = new AttachConsentRequiredError(9222);
    expect(err.errorCode).toBe('attach_consent_required');
    expect(err.port).toBe(9222);
    expect(err.message).toContain('9222');
    expect(err.message).toContain('--remote-debugging-port');
    expect(err.hint).toContain('OPENCHROME_LAUNCH_MODE=auto');
    // Policy promise: never auto-restart user's Chrome.
    expect(err.message).toContain('NOT close or restart');
  });
});
