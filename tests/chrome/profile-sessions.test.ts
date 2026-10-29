import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProfileManager } from '../../src/chrome/profile-manager';
import { parseCmdline } from '../../src/chrome/process-detector';
import { resolveOnBusyMode } from '../../src/chrome/overflow-session';
import {
  hasLiveProfileUsers,
  readDevToolsActivePort,
  registerProfileUser,
  releaseProfileUser,
} from '../../src/chrome/profile-users';

function makeUserDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-profile-sessions-'));
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        Default: { name: 'Personal', user_name: 'me@example.com' },
        'Profile 3': { name: 'Work', user_name: 'work@example.com' },
        'Profile 4': { name: 'Workshop' },
        'Profile 5': { name: '가족' },
      },
    },
  }));
  return dir;
}

describe('ProfileManager.resolveProfileDirectory', () => {
  const dir = makeUserDataDir();
  const pm = new ProfileManager();

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['Profile 3', 'Profile 3'],
    ['profile 3', 'Profile 3'],
    ['work', 'Profile 3'],
    ['me@example.com', 'Default'],
    ['가족', 'Profile 5'],
    ['shop', 'Profile 4'],
  ])('resolves %s -> %s', (query, expected) => {
    expect(pm.resolveProfileDirectory(query, dir)).toBe(expected);
  });

  it('prefers an exact name over a substring match', () => {
    // "Work" is both exact (Profile 3) and a substring of "Workshop".
    expect(pm.resolveProfileDirectory('Work', dir)).toBe('Profile 3');
  });

  it('rejects ambiguous substrings and unknown profiles with the candidate list', () => {
    expect(() => pm.resolveProfileDirectory('or', dir)).toThrow(/ambiguous/);
    expect(() => pm.resolveProfileDirectory('nobody', dir)).toThrow(/not found.*Profile 3/);
  });
});

describe('process-detector parseCmdline', () => {
  it('keeps spaces in unquoted flag values (ps drops quoting)', () => {
    const chrome = parseCmdline(1, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Profile 62 --remote-debugging-port=9334 --user-data-dir=/Users/me/Library/Application Support/X');
    expect(chrome.profileDirectory).toBe('Profile 62');
    expect(chrome.userDataDir).toBe('/Users/me/Library/Application Support/X');
    expect(chrome.hasDebugPort).toBe(true);
  });
});

describe('resolveOnBusyMode', () => {
  it('reads CLI first, then env, and rejects unknown modes', () => {
    expect(resolveOnBusyMode('new-port', {})).toBe('new-port');
    expect(resolveOnBusyMode(undefined, { OPENCHROME_ON_BUSY: 'BROKER' })).toBe('broker');
    expect(resolveOnBusyMode(undefined, {})).toBeUndefined();
    expect(() => resolveOnBusyMode('fork', {})).toThrow(/Unknown --on-busy/);
  });
});

describe('profile-users registry', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-profile-users-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('the last live user is responsible for closing', () => {
    registerProfileUser(dir, process.pid);
    registerProfileUser(dir, process.ppid);
    // Another live process still uses it.
    expect(releaseProfileUser(dir, process.pid)).toBe(false);
    expect(hasLiveProfileUsers(dir)).toBe(true);
    expect(releaseProfileUser(dir, process.ppid)).toBe(true);
    expect(hasLiveProfileUsers(dir)).toBe(false);
  });

  it('prunes dead users', () => {
    registerProfileUser(dir, 999_999_9);
    expect(releaseProfileUser(dir, process.pid)).toBe(true);
    expect(fs.readdirSync(path.join(dir, '.openchrome-users'))).toEqual([]);
  });

  it('reads the DevToolsActivePort port line', () => {
    expect(readDevToolsActivePort(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '9334\n/devtools/browser/abc\n');
    expect(readDevToolsActivePort(dir)).toBe(9334);
  });
});

describe('host profile tabs', () => {
  it('closes every tracked tab once and skips untracked ones', async () => {
    const { trackHostProfileTab, untrackHostProfileTab, closeHostProfileTabs } = await import('../../src/chrome/host-profile-tabs');
    const closed: string[] = [];
    trackHostProfileTab('a', async () => { closed.push('a'); });
    trackHostProfileTab('b', async () => { closed.push('b'); });
    trackHostProfileTab('c', () => Promise.reject(new Error('already gone')));
    untrackHostProfileTab('b');
    expect(await closeHostProfileTabs()).toBe(2);
    expect(closed).toEqual(['a']);
    expect(await closeHostProfileTabs()).toBe(0);
  });

  it('does not wait past the timeout for a hung close', async () => {
    const { trackHostProfileTab, closeHostProfileTabs } = await import('../../src/chrome/host-profile-tabs');
    trackHostProfileTab('hung', () => new Promise<void>(() => {}));
    const t0 = Date.now();
    await closeHostProfileTabs(50);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
