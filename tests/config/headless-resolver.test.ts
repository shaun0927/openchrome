import { resolveHeadlessMode, HeadlessFlagConflictError } from '../../src/config/headless-resolver';

describe('resolveHeadlessMode (#657)', () => {
  describe('CLI flag precedence', () => {
    it('returns headless when --headless is true', () => {
      expect(resolveHeadlessMode({ headless: true }, {}, {})).toBe('headless');
    });

    it('returns headed when --visible is true', () => {
      expect(resolveHeadlessMode({ visible: true }, {}, {})).toBe('headed');
    });

    it('throws HeadlessFlagConflictError when both --headless and --visible are true', () => {
      expect(() => resolveHeadlessMode({ headless: true, visible: true }, {}, {})).toThrow(HeadlessFlagConflictError);
    });

    it('CLI --headless overrides env and config', () => {
      expect(
        resolveHeadlessMode(
          { headless: true },
          { OPENCHROME_HEADLESS: '0' },
          { headless: false },
        ),
      ).toBe('headless');
    });

    it('CLI --visible overrides env and config', () => {
      expect(
        resolveHeadlessMode(
          { visible: true },
          { OPENCHROME_HEADLESS: '1' },
          { headless: true },
        ),
      ).toBe('headed');
    });
  });

  describe('environment variable', () => {
    it.each(['1', 'true', 'TRUE', 'yes', 'Yes'])('%s → headless', (value) => {
      expect(resolveHeadlessMode({}, { OPENCHROME_HEADLESS: value }, {})).toBe('headless');
    });

    it.each(['0', 'false', 'FALSE', 'no', 'No'])('%s → headed', (value) => {
      expect(resolveHeadlessMode({}, { OPENCHROME_HEADLESS: value }, {})).toBe('headed');
    });

    it('unrecognized value falls through to config / default', () => {
      expect(resolveHeadlessMode({}, { OPENCHROME_HEADLESS: 'maybe' }, { headless: true })).toBe('headless');
      expect(resolveHeadlessMode({}, { OPENCHROME_HEADLESS: 'maybe' }, {})).toBe('headed');
    });

    it('empty string is ignored', () => {
      expect(resolveHeadlessMode({}, { OPENCHROME_HEADLESS: '' }, { headless: true })).toBe('headless');
    });

    it('whitespace is trimmed', () => {
      expect(resolveHeadlessMode({}, { OPENCHROME_HEADLESS: '  1  ' }, {})).toBe('headless');
    });
  });

  describe('config layer', () => {
    it('config.headless=true → headless', () => {
      expect(resolveHeadlessMode({}, {}, { headless: true })).toBe('headless');
    });

    it('config.headless=false → headed', () => {
      expect(resolveHeadlessMode({}, {}, { headless: false })).toBe('headed');
    });

    it('env overrides config', () => {
      expect(resolveHeadlessMode({}, { OPENCHROME_HEADLESS: '1' }, { headless: false })).toBe('headless');
      expect(resolveHeadlessMode({}, { OPENCHROME_HEADLESS: '0' }, { headless: true })).toBe('headed');
    });
  });

  describe('default (no input)', () => {
    it('returns headed when nothing is specified', () => {
      expect(resolveHeadlessMode({}, {}, {})).toBe('headed');
    });

    it('headless=undefined and visible=undefined behaves like empty', () => {
      expect(
        resolveHeadlessMode({ headless: undefined, visible: undefined }, {}, {}),
      ).toBe('headed');
    });
  });

  describe('conflict-error message', () => {
    it('mentions both flags', () => {
      try {
        resolveHeadlessMode({ headless: true, visible: true }, {}, {});
        fail('expected throw');
      } catch (err) {
        expect((err as Error).message).toContain('--headless');
        expect((err as Error).message).toContain('--visible');
      }
    });
  });
});
