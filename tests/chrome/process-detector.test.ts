import {
  pickPreferredChrome,
  filterByProfile,
  DetectedChrome,
  ChromeVariant,
} from '../../src/chrome/process-detector';

function entry(pid: number, variant: ChromeVariant, profile: string | null = null): DetectedChrome {
  return {
    pid,
    cmdline: `${variant} --profile-directory=${profile ?? ''}`,
    variant,
    profileDirectory: profile,
    userDataDir: null,
    hasDebugPort: false,
  };
}

describe('pickPreferredChrome (#659 policy)', () => {
  it('returns null on empty input', () => {
    expect(pickPreferredChrome([])).toBeNull();
  });

  it('Stable beats Beta', () => {
    expect(pickPreferredChrome([entry(2, 'beta'), entry(1, 'stable')])!.variant).toBe('stable');
  });

  it('Beta beats Canary', () => {
    expect(pickPreferredChrome([entry(1, 'canary'), entry(2, 'beta')])!.variant).toBe('beta');
  });

  it('Canary beats Chromium', () => {
    expect(pickPreferredChrome([entry(1, 'chromium'), entry(2, 'canary')])!.variant).toBe('canary');
  });

  it('Chromium beats unknown', () => {
    expect(pickPreferredChrome([entry(1, 'unknown'), entry(2, 'chromium')])!.variant).toBe('chromium');
  });

  it('lowest PID wins as tiebreaker within same variant', () => {
    expect(pickPreferredChrome([entry(50, 'stable'), entry(2, 'stable'), entry(99, 'stable')])!.pid).toBe(2);
  });
});

describe('filterByProfile (#659)', () => {
  const all = [
    entry(1, 'stable', 'Profile 1'),
    entry(2, 'stable', 'Default'),
    entry(3, 'beta', 'Profile 1'),
    entry(4, 'canary', null),
  ];

  it('returns all candidates when no profile requested', () => {
    expect(filterByProfile(all)).toEqual(all);
    expect(filterByProfile(all, undefined)).toEqual(all);
  });

  it('matches exact profile string', () => {
    const result = filterByProfile(all, 'Profile 1');
    expect(result.map((c) => c.pid).sort()).toEqual([1, 3]);
  });

  it('returns empty when no match', () => {
    expect(filterByProfile(all, 'Profile 99')).toEqual([]);
  });

  it('combined with pickPreferredChrome → policy decision', () => {
    const matching = filterByProfile(all, 'Profile 1');
    const chosen = pickPreferredChrome(matching);
    // Stable beats Beta, even though both have Profile 1.
    expect(chosen!.pid).toBe(1);
    expect(chosen!.variant).toBe('stable');
  });
});
