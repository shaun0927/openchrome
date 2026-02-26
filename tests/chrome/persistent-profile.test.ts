/**
 * Tests for Persistent OpenChrome Profile architecture (Issue #74)
 *
 * Covers:
 * 1. ProfileManager.getOrCreatePersistentProfile() — directory creation
 * 2. ProfileManager.needsSync() — freshness-based sync decision
 * 3. ProfileManager.syncCookies() — atomic SQLite backup + fallback
 * 4. ProfileManager.getSyncMetadata() / updateSyncMetadata() — metadata persistence
 * 5. ProfileManager.resolveProfile() — profile selection priority
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Override the global mock from tests/setup.ts
jest.unmock('../../src/chrome/profile-manager');

import { ProfileManager } from '../../src/chrome/profile-manager';
import type { SyncMetadata } from '../../src/chrome/profile-manager';

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execSync: jest.fn(),
  };
});

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe('ProfileManager', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let tmpDir: string;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockExecSync.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pm-test-'));

    // Override static constants to use temp directories for test isolation
    Object.defineProperty(ProfileManager, 'PERSISTENT_PROFILE_DIR', {
      value: path.join(tmpDir, 'persistent-profile'),
      configurable: true,
    });
    Object.defineProperty(ProfileManager, 'SYNC_METADATA_PATH', {
      value: path.join(tmpDir, 'sync-metadata.json'),
      configurable: true,
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // getOrCreatePersistentProfile()
  // =========================================================================

  describe('getOrCreatePersistentProfile()', () => {
    it('should create persistent profile directory if it does not exist', () => {
      const manager = new ProfileManager();
      const result = manager.getOrCreatePersistentProfile();

      expect(result).toBe(ProfileManager.PERSISTENT_PROFILE_DIR);
      expect(fs.existsSync(result)).toBe(true);
      expect(fs.existsSync(path.join(result, 'Default'))).toBe(true);
    });

    it('should return existing directory without recreating', () => {
      const profileDir = ProfileManager.PERSISTENT_PROFILE_DIR;
      fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });

      const manager = new ProfileManager();
      const result = manager.getOrCreatePersistentProfile();

      expect(result).toBe(profileDir);
      expect(fs.existsSync(path.join(result, 'Default'))).toBe(true);
    });

    it('should create Default subdirectory even if parent exists', () => {
      const profileDir = ProfileManager.PERSISTENT_PROFILE_DIR;
      fs.mkdirSync(profileDir, { recursive: true });
      // Default/ doesn't exist yet

      const manager = new ProfileManager();
      manager.getOrCreatePersistentProfile();

      expect(fs.existsSync(path.join(profileDir, 'Default'))).toBe(true);
    });
  });

  // =========================================================================
  // needsSync()
  // =========================================================================

  describe('needsSync()', () => {
    let sourceDir: string;

    beforeEach(() => {
      sourceDir = path.join(tmpDir, 'source-profile');
      fs.mkdirSync(path.join(sourceDir, 'Default'), { recursive: true });
    });

    it('should return true when no sync metadata exists', () => {
      // No metadata file — never synced
      fs.writeFileSync(path.join(sourceDir, 'Default', 'Cookies'), 'data');

      const manager = new ProfileManager();
      expect(manager.needsSync(sourceDir)).toBe(true);
    });

    it('should return true when source cookies changed (hash mismatch)', () => {
      // Write metadata with old hash
      const metadata: SyncMetadata = {
        lastSyncTimestamp: Date.now(),
        sourceProfileHash: '999999:100', // Different from actual file
        syncCount: 1,
        sourceProfileDir: sourceDir,
      };
      fs.writeFileSync(ProfileManager.SYNC_METADATA_PATH, JSON.stringify(metadata));
      fs.writeFileSync(path.join(sourceDir, 'Default', 'Cookies'), 'cookie-data');

      const manager = new ProfileManager();
      expect(manager.needsSync(sourceDir)).toBe(true);
    });

    it('should return true when cookies are stale (> 30 min)', () => {
      // Create source Cookies file first to compute hash
      const cookiesPath = path.join(sourceDir, 'Default', 'Cookies');
      fs.writeFileSync(cookiesPath, 'cookie-data');
      const stat = fs.statSync(cookiesPath);
      const hash = `${stat.mtimeMs}:${stat.size}`;

      // Write metadata with matching hash but old timestamp
      const metadata: SyncMetadata = {
        lastSyncTimestamp: Date.now() - (31 * 60 * 1000), // 31 minutes ago
        sourceProfileHash: hash,
        syncCount: 1,
        sourceProfileDir: sourceDir,
      };
      fs.writeFileSync(ProfileManager.SYNC_METADATA_PATH, JSON.stringify(metadata));

      const manager = new ProfileManager();
      expect(manager.needsSync(sourceDir)).toBe(true);
    });

    it('should return false when cookies are fresh and unchanged', () => {
      // Create source Cookies file
      const cookiesPath = path.join(sourceDir, 'Default', 'Cookies');
      fs.writeFileSync(cookiesPath, 'cookie-data');
      const stat = fs.statSync(cookiesPath);
      const hash = `${stat.mtimeMs}:${stat.size}`;

      // Write metadata with current timestamp and matching hash
      const metadata: SyncMetadata = {
        lastSyncTimestamp: Date.now(),
        sourceProfileHash: hash,
        syncCount: 1,
        sourceProfileDir: sourceDir,
      };
      fs.writeFileSync(ProfileManager.SYNC_METADATA_PATH, JSON.stringify(metadata));

      const manager = new ProfileManager();
      expect(manager.needsSync(sourceDir)).toBe(false);
    });

    it('should return false when source Cookies file does not exist but metadata exists', () => {
      // No Cookies file, but metadata exists → can't sync
      const metadata: SyncMetadata = {
        lastSyncTimestamp: Date.now(),
        sourceProfileHash: 'old',
        syncCount: 1,
        sourceProfileDir: sourceDir,
      };
      fs.writeFileSync(ProfileManager.SYNC_METADATA_PATH, JSON.stringify(metadata));

      const manager = new ProfileManager();
      expect(manager.needsSync(sourceDir)).toBe(false);
    });
  });

  // =========================================================================
  // syncCookies()
  // =========================================================================

  describe('syncCookies()', () => {
    let sourceDir: string;
    let destDir: string;

    beforeEach(() => {
      sourceDir = path.join(tmpDir, 'source');
      destDir = path.join(tmpDir, 'dest');
      fs.mkdirSync(path.join(sourceDir, 'Default'), { recursive: true });
    });

    it('should use sqlite3 backup when available and return atomic: true', () => {
      fs.writeFileSync(path.join(sourceDir, 'Default', 'Cookies'), 'cookie-db');

      // Mock: `which sqlite3` succeeds, backup command succeeds
      mockExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('which sqlite3') || cmdStr.includes('where sqlite3')) {
          return Buffer.from('/usr/bin/sqlite3');
        }
        if (cmdStr.includes('sqlite3') && cmdStr.includes('.backup')) {
          // Simulate creating the backup file
          const destDefault = path.join(destDir, 'Default');
          fs.mkdirSync(destDefault, { recursive: true });
          fs.writeFileSync(path.join(destDefault, 'Cookies'), 'backed-up-db');
          return Buffer.from('');
        }
        return Buffer.from('');
      });

      const manager = new ProfileManager();
      const result = manager.syncCookies(sourceDir, destDir);

      expect(result.atomic).toBe(true);
    });

    it('should fall back to fs.copyFileSync when sqlite3 not available', () => {
      fs.writeFileSync(path.join(sourceDir, 'Default', 'Cookies'), 'cookie-db');

      // Mock: `which sqlite3` fails
      mockExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('which sqlite3') || cmdStr.includes('where sqlite3')) {
          throw new Error('not found');
        }
        return Buffer.from('');
      });

      const manager = new ProfileManager();
      const result = manager.syncCookies(sourceDir, destDir);

      expect(result.atomic).toBe(false);
      // Cookies should have been copied via fs.copyFileSync
      expect(fs.existsSync(path.join(destDir, 'Default', 'Cookies'))).toBe(true);
    });

    it('should clean up WAL/SHM/journal files after atomic backup', () => {
      fs.writeFileSync(path.join(sourceDir, 'Default', 'Cookies'), 'cookie-db');

      // Pre-create stale WAL/SHM/journal at dest
      fs.mkdirSync(path.join(destDir, 'Default'), { recursive: true });
      fs.writeFileSync(path.join(destDir, 'Default', 'Cookies-wal'), 'stale-wal');
      fs.writeFileSync(path.join(destDir, 'Default', 'Cookies-shm'), 'stale-shm');
      fs.writeFileSync(path.join(destDir, 'Default', 'Cookies-journal'), 'stale-journal');

      mockExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('which sqlite3') || cmdStr.includes('where sqlite3')) {
          return Buffer.from('/usr/bin/sqlite3');
        }
        if (cmdStr.includes('.backup')) {
          return Buffer.from('');
        }
        return Buffer.from('');
      });

      const manager = new ProfileManager();
      manager.syncCookies(sourceDir, destDir);

      // WAL/SHM/journal should be cleaned up
      expect(fs.existsSync(path.join(destDir, 'Default', 'Cookies-wal'))).toBe(false);
      expect(fs.existsSync(path.join(destDir, 'Default', 'Cookies-shm'))).toBe(false);
      expect(fs.existsSync(path.join(destDir, 'Default', 'Cookies-journal'))).toBe(false);
    });

    it('should copy and patch Preferences', () => {
      const sourcePrefs = {
        profile: { exit_type: 'Crashed', exited_cleanly: false, name: 'Default' },
        session: { startup_urls: ['https://example.com'], restore_on_startup: 1 },
      };
      fs.writeFileSync(
        path.join(sourceDir, 'Default', 'Preferences'),
        JSON.stringify(sourcePrefs)
      );

      mockExecSync.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes('which sqlite3') || String(cmd).includes('where sqlite3')) {
          throw new Error('not found');
        }
        return Buffer.from('');
      });

      const manager = new ProfileManager();
      manager.syncCookies(sourceDir, destDir);

      const destPrefsPath = path.join(destDir, 'Default', 'Preferences');
      expect(fs.existsSync(destPrefsPath)).toBe(true);

      const destPrefs = JSON.parse(fs.readFileSync(destPrefsPath, 'utf8'));
      expect(destPrefs.profile.exit_type).toBe('Normal');
      expect(destPrefs.profile.exited_cleanly).toBe(true);
      expect(destPrefs.profile.name).toBe('Default'); // Other fields preserved
      expect(destPrefs.session.restore_on_startup).toBe(5);
      expect(destPrefs.session.startup_urls).toBeUndefined();
    });

    it('should copy Local State file', () => {
      fs.writeFileSync(path.join(sourceDir, 'Local State'), '{"os_crypt":{"key":"abc"}}');

      mockExecSync.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes('which sqlite3') || String(cmd).includes('where sqlite3')) {
          throw new Error('not found');
        }
        return Buffer.from('');
      });

      const manager = new ProfileManager();
      manager.syncCookies(sourceDir, destDir);

      expect(fs.existsSync(path.join(destDir, 'Local State'))).toBe(true);
      expect(fs.readFileSync(path.join(destDir, 'Local State'), 'utf8')).toBe(
        '{"os_crypt":{"key":"abc"}}'
      );
    });

    it('should handle missing source Cookies file gracefully', () => {
      // No Cookies file in source
      mockExecSync.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes('which sqlite3') || String(cmd).includes('where sqlite3')) {
          throw new Error('not found');
        }
        return Buffer.from('');
      });

      const manager = new ProfileManager();
      expect(() => manager.syncCookies(sourceDir, destDir)).not.toThrow();
    });

    it('should update sync metadata after successful sync', () => {
      fs.writeFileSync(path.join(sourceDir, 'Default', 'Cookies'), 'cookie-db');

      mockExecSync.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes('which sqlite3') || String(cmd).includes('where sqlite3')) {
          throw new Error('not found');
        }
        return Buffer.from('');
      });

      const manager = new ProfileManager();
      manager.syncCookies(sourceDir, destDir);

      const metadata = manager.getSyncMetadata();
      expect(metadata).not.toBeNull();
      expect(metadata!.syncCount).toBe(1);
      expect(metadata!.sourceProfileDir).toBe(sourceDir);
    });
  });

  // =========================================================================
  // getSyncMetadata()
  // =========================================================================

  describe('getSyncMetadata()', () => {
    it('should return null when metadata file does not exist', () => {
      const manager = new ProfileManager();
      expect(manager.getSyncMetadata()).toBeNull();
    });

    it('should parse valid metadata JSON', () => {
      const metadata: SyncMetadata = {
        lastSyncTimestamp: 1700000000000,
        sourceProfileHash: '123456:1024',
        syncCount: 5,
        sourceProfileDir: '/some/path',
      };
      fs.writeFileSync(ProfileManager.SYNC_METADATA_PATH, JSON.stringify(metadata));

      const manager = new ProfileManager();
      const result = manager.getSyncMetadata();

      expect(result).toEqual(metadata);
    });

    it('should return null on corrupted JSON', () => {
      fs.writeFileSync(ProfileManager.SYNC_METADATA_PATH, 'not valid json {{{');

      const manager = new ProfileManager();
      expect(manager.getSyncMetadata()).toBeNull();
    });
  });

  // =========================================================================
  // updateSyncMetadata()
  // =========================================================================

  describe('updateSyncMetadata()', () => {
    let sourceDir: string;

    beforeEach(() => {
      sourceDir = path.join(tmpDir, 'source');
      fs.mkdirSync(path.join(sourceDir, 'Default'), { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'Default', 'Cookies'), 'data');
    });

    it('should write metadata with a current timestamp', () => {
      const manager = new ProfileManager();
      const before = Date.now();
      manager.updateSyncMetadata(sourceDir);
      const after = Date.now();

      const metadata = manager.getSyncMetadata();
      expect(metadata).not.toBeNull();
      expect(metadata!.lastSyncTimestamp).toBeGreaterThanOrEqual(before);
      expect(metadata!.lastSyncTimestamp).toBeLessThanOrEqual(after);
    });

    it('should increment syncCount from 0 to 1', () => {
      const manager = new ProfileManager();
      manager.updateSyncMetadata(sourceDir);

      const metadata = manager.getSyncMetadata();
      expect(metadata!.syncCount).toBe(1);
    });

    it('should increment syncCount from existing value', () => {
      // Write initial metadata
      const initial: SyncMetadata = {
        lastSyncTimestamp: Date.now() - 1000,
        sourceProfileHash: 'old-hash',
        syncCount: 3,
        sourceProfileDir: sourceDir,
      };
      fs.writeFileSync(ProfileManager.SYNC_METADATA_PATH, JSON.stringify(initial));

      const manager = new ProfileManager();
      manager.updateSyncMetadata(sourceDir);

      const metadata = manager.getSyncMetadata();
      expect(metadata!.syncCount).toBe(4);
    });

    it('should update sourceProfileHash to reflect current Cookies file', () => {
      const cookiesPath = path.join(sourceDir, 'Default', 'Cookies');
      const stat = fs.statSync(cookiesPath);
      const expectedHash = `${stat.mtimeMs}:${stat.size}`;

      const manager = new ProfileManager();
      manager.updateSyncMetadata(sourceDir);

      const metadata = manager.getSyncMetadata();
      expect(metadata!.sourceProfileHash).toBe(expectedHash);
    });
  });

  // =========================================================================
  // resolveProfile()
  // =========================================================================

  describe('resolveProfile()', () => {
    it('should return explicit profile when explicitUserDataDir provided', () => {
      const manager = new ProfileManager();
      const result = manager.resolveProfile({
        realProfileDir: '/some/chrome/profile',
        isProfileLocked: false,
        explicitUserDataDir: '/my/custom/dir',
      });

      expect(result.profileType).toBe('explicit');
      expect(result.userDataDir).toBe('/my/custom/dir');
      expect(result.syncPerformed).toBe(false);
    });

    it('should return temp profile when useTempProfile is true', () => {
      const manager = new ProfileManager();
      const result = manager.resolveProfile({
        realProfileDir: '/some/chrome/profile',
        isProfileLocked: false,
        useTempProfile: true,
      });

      expect(result.profileType).toBe('temp');
      expect(result.userDataDir).toContain('openchrome-');
      expect(result.syncPerformed).toBe(false);
    });

    it('should return temp profile when usingHeadlessShell is true', () => {
      const manager = new ProfileManager();
      const result = manager.resolveProfile({
        realProfileDir: '/some/chrome/profile',
        isProfileLocked: false,
        usingHeadlessShell: true,
      });

      expect(result.profileType).toBe('temp');
      expect(result.syncPerformed).toBe(false);
    });

    it('should return real profile when realProfileDir provided and not locked', () => {
      const manager = new ProfileManager();
      const result = manager.resolveProfile({
        realProfileDir: '/real/chrome/profile',
        isProfileLocked: false,
      });

      expect(result.profileType).toBe('real');
      expect(result.userDataDir).toBe('/real/chrome/profile');
      expect(result.syncPerformed).toBe(false);
    });

    it('should return persistent profile with sync when locked and stale', () => {
      const manager = new ProfileManager();
      jest.spyOn(manager, 'needsSync').mockReturnValue(true);
      jest.spyOn(manager, 'syncCookies').mockReturnValue({ atomic: true });
      jest.spyOn(manager, 'getOrCreatePersistentProfile').mockReturnValue('/mock/persistent');

      const result = manager.resolveProfile({
        realProfileDir: '/real/chrome/profile',
        isProfileLocked: true,
      });

      expect(result.profileType).toBe('persistent');
      expect(result.userDataDir).toBe('/mock/persistent');
      expect(result.syncPerformed).toBe(true);
      expect(manager.syncCookies).toHaveBeenCalledWith('/real/chrome/profile', '/mock/persistent');
    });

    it('should return persistent profile without sync when locked but fresh', () => {
      const manager = new ProfileManager();
      jest.spyOn(manager, 'needsSync').mockReturnValue(false);
      jest.spyOn(manager, 'syncCookies');
      jest.spyOn(manager, 'getOrCreatePersistentProfile').mockReturnValue('/mock/persistent');

      const result = manager.resolveProfile({
        realProfileDir: '/real/chrome/profile',
        isProfileLocked: true,
      });

      expect(result.profileType).toBe('persistent');
      expect(result.userDataDir).toBe('/mock/persistent');
      expect(result.syncPerformed).toBe(false);
      expect(manager.syncCookies).not.toHaveBeenCalled();
    });

    it('should return persistent profile when no real profile dir exists', () => {
      const manager = new ProfileManager();
      jest.spyOn(manager, 'getOrCreatePersistentProfile').mockReturnValue('/mock/persistent');

      const result = manager.resolveProfile({
        realProfileDir: null,
        isProfileLocked: false,
      });

      expect(result.profileType).toBe('persistent');
      expect(result.userDataDir).toBe('/mock/persistent');
      expect(result.syncPerformed).toBe(false);
    });
  });
});
