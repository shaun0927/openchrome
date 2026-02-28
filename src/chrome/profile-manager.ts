/**
 * ProfileManager - Persistent OpenChrome Profile Architecture
 *
 * Manages a persistent Chrome profile directory at ~/.openchrome/profile/
 * instead of creating disposable temp profiles on every launch.
 * Provides atomic cookie sync using the SQLite backup API.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProfileType = 'real' | 'persistent' | 'temp' | 'explicit';

export interface SyncMetadata {
  lastSyncTimestamp: number;
  /** `${mtimeMs}:${size}` of the source Cookies file at sync time */
  sourceProfileHash: string;
  syncCount: number;
  sourceProfileDir: string;
}

export interface ProfileResolution {
  userDataDir: string;
  profileType: ProfileType;
  syncPerformed: boolean;
}

// ---------------------------------------------------------------------------
// ProfileManager
// ---------------------------------------------------------------------------

/**
 * Manages persistent OpenChrome Chrome profiles and cookie synchronisation.
 *
 * Key responsibilities:
 * - Maintain a reusable profile at `~/.openchrome/profile/` so cookies and
 *   session data survive across OpenChrome restarts.
 * - Track whether the persistent profile is stale relative to the real
 *   Chrome profile using lightweight file-stat hashing.
 * - Perform atomic cookie sync via the `sqlite3` CLI `.backup` command when
 *   available, falling back to a plain file copy otherwise.
 * - Decide which profile directory Chrome should use (`resolveProfile`).
 */
export class ProfileManager {
  // -------------------------------------------------------------------------
  // Constants (configurable via Object.defineProperty for testing)
  // -------------------------------------------------------------------------

  /** Root directory for the persistent OpenChrome profile. */
  static readonly PERSISTENT_PROFILE_DIR = path.join(
    os.homedir(),
    '.openchrome',
    'profile'
  );

  /** Path to the JSON file that tracks the last sync state. */
  static readonly SYNC_METADATA_PATH = path.join(
    os.homedir(),
    '.openchrome',
    'sync-metadata.json'
  );

  /** Cookie data is considered fresh if synced within this window (30 min). */
  static readonly COOKIE_FRESHNESS_MS = 30 * 60 * 1000;

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  /**
   * Return the persistent profile directory, creating it (including the
   * `Default/` subdirectory) if it does not already exist.
   */
  getOrCreatePersistentProfile(): string {
    const profileDir = ProfileManager.PERSISTENT_PROFILE_DIR;
    const defaultDir = path.join(profileDir, 'Default');

    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
      console.error(
        `[ProfileManager] Created persistent profile directory: ${profileDir}`
      );
    }

    if (!fs.existsSync(defaultDir)) {
      fs.mkdirSync(defaultDir, { recursive: true });
    }

    return profileDir;
  }

  /**
   * Determine whether the persistent profile needs a fresh cookie sync from
   * `sourceDir`.
   *
   * Returns `true` when:
   * - No sync metadata exists (never synced before), OR
   * - The source Cookies file has changed since the last sync (different
   *   mtime or size), OR
   * - The last sync is older than `COOKIE_FRESHNESS_MS`.
   */
  needsSync(sourceDir: string): boolean {
    const metadata = this.getSyncMetadata();

    if (!metadata) {
      return true; // Never synced
    }

    // Compute current hash of the source Cookies file
    const sourceCookiesPath = path.join(sourceDir, 'Default', 'Cookies');
    let currentHash: string;
    try {
      const stat = fs.statSync(sourceCookiesPath);
      currentHash = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // Cookies file doesn't exist in source — no sync possible
      if (!metadata) {
        console.error('[ProfileManager] Source Cookies not found and no prior sync — persistent profile will have no cookies');
      }
      return false;
    }

    if (currentHash !== metadata.sourceProfileHash) {
      return true; // Source has changed
    }

    if (Date.now() - metadata.lastSyncTimestamp > ProfileManager.COOKIE_FRESHNESS_MS) {
      return true; // Stale
    }

    return false;
  }

  /**
   * Synchronise cookies (and Preferences) from `sourceDir` into `destDir`.
   *
   * Uses the `sqlite3` CLI `.backup` command for an atomic, consistent
   * snapshot of the Cookies database. Falls back to a plain file copy when
   * `sqlite3` is not available.
   *
   * After a successful sync the metadata file is updated via
   * `updateSyncMetadata`.
   *
   * @returns `{ atomic: true, success: true }` when sqlite3 backup was used,
   *          `{ atomic: false, success: true }` when the plain-copy fallback was used,
   *          `{ atomic: false, success: false }` when all methods failed.
   */
  syncCookies(
    sourceDir: string,
    destDir: string
  ): { atomic: boolean; success: boolean } {
    try {
      const destDefault = path.join(destDir, 'Default');
      fs.mkdirSync(destDefault, { recursive: true });

      // --- 1. Copy Local State -----------------------------------------------
      const localStateSrc = path.join(sourceDir, 'Local State');
      if (fs.existsSync(localStateSrc)) {
        fs.copyFileSync(localStateSrc, path.join(destDir, 'Local State'));
      }

      // --- 2. Sync Cookies (atomic via sqlite3, or plain copy fallback) ------
      const sourceCookiesPath = path.join(sourceDir, 'Default', 'Cookies');
      const destCookiesPath = path.join(destDefault, 'Cookies');
      let atomic = false;

      if (fs.existsSync(sourceCookiesPath)) {
        const sqlite3Available = this._isSqlite3Available();

        if (sqlite3Available) {
          // Atomic backup using the SQLite .backup command.
          // This works even when Chrome is actively writing to the DB.
          // Uses execFileSync (no shell) to prevent injection via path characters.
          if (process.platform === 'win32' && destCookiesPath.includes('"')) {
            throw new Error('sqlite3 .backup: destination path contains \'"\', cannot quote safely on Windows');
          }
          const backupCmd = process.platform === 'win32'
            ? `.backup "${destCookiesPath}"`
            : `.backup '${destCookiesPath.replace(/'/g, "''")}'`;
          execFileSync('sqlite3', [
            sourceCookiesPath,
            backupCmd,
          ], { stdio: 'ignore', timeout: 10000 });

          // .backup produces a clean WAL-checkpoint DB — remove stale WAL/SHM/journal
          // at the destination so Chrome doesn't get confused.
          for (const suffix of ['Cookies-wal', 'Cookies-shm', 'Cookies-journal']) {
            const stale = path.join(destDefault, suffix);
            if (fs.existsSync(stale)) {
              try {
                fs.unlinkSync(stale);
              } catch {
                // Non-fatal
              }
            }
          }

          atomic = true;
        } else {
          // sqlite3 not available — fall back to plain file copy (same as
          // the legacy copyEssentialProfileData behaviour).
          console.error(
            '[ProfileManager] sqlite3 not found, falling back to non-atomic cookie copy'
          );

          const cookieFiles = [
            'Cookies',
            'Cookies-wal',
            'Cookies-shm',
            'Cookies-journal',
          ];
          for (const file of cookieFiles) {
            const src = path.join(sourceDir, 'Default', file);
            if (fs.existsSync(src)) {
              try {
                fs.copyFileSync(src, path.join(destDefault, file));
              } catch {
                // Individual file copy failure is non-fatal
              }
            }
          }

          atomic = false;
        }
      }

      // --- 3. Copy and patch Preferences ------------------------------------
      const prefsSrc = path.join(sourceDir, 'Default', 'Preferences');
      if (fs.existsSync(prefsSrc)) {
        try {
          const prefsContent = fs.readFileSync(prefsSrc, 'utf8');
          const prefs = JSON.parse(prefsContent);

          // Prevent "Chrome didn't shut down correctly" prompt
          if (prefs.profile) {
            prefs.profile.exit_type = 'Normal';
            prefs.profile.exited_cleanly = true;
          }

          // Suppress session restore so copied profile doesn't reopen old tabs
          if (!prefs.session) prefs.session = {};
          prefs.session.restore_on_startup = 5; // 5 = open new tab page
          delete prefs.session.startup_urls;

          fs.writeFileSync(
            path.join(destDefault, 'Preferences'),
            JSON.stringify(prefs)
          );
        } catch {
          // JSON parse failed — skip Preferences entirely.
          // Chrome will create fresh defaults.
        }
      }

      // --- 4. Update metadata -----------------------------------------------
      this.updateSyncMetadata(sourceDir);

      console.error(
        `[ProfileManager] Cookie sync complete (atomic=${atomic}) from ${sourceDir} → ${destDir}`
      );
      return { atomic, success: true };
    } catch (err) {
      console.error(
        '[ProfileManager] syncCookies failed (non-fatal):',
        err
      );
      return { atomic: false, success: false };
    }
  }

  /**
   * Read the current sync metadata from disk.
   *
   * @returns Parsed `SyncMetadata` or `null` if the file does not exist or
   *          cannot be parsed.
   */
  getSyncMetadata(): SyncMetadata | null {
    try {
      const raw = fs.readFileSync(ProfileManager.SYNC_METADATA_PATH, 'utf8');
      return JSON.parse(raw) as SyncMetadata;
    } catch {
      return null;
    }
  }

  /**
   * Persist sync metadata for `sourceDir` using a temp-file + rename pattern
   * to prevent corruption on concurrent writes.
   */
  updateSyncMetadata(sourceDir: string): void {
    try {
      // Compute source hash
      const sourceCookiesPath = path.join(sourceDir, 'Default', 'Cookies');
      let sourceProfileHash = '';
      try {
        const stat = fs.statSync(sourceCookiesPath);
        sourceProfileHash = `${stat.mtimeMs}:${stat.size}`;
      } catch {
        // Cookies file missing — leave hash empty
      }

      const existing = this.getSyncMetadata();
      const updated: SyncMetadata = {
        lastSyncTimestamp: Date.now(),
        sourceProfileHash,
        syncCount: existing ? existing.syncCount + 1 : 1,
        sourceProfileDir: sourceDir,
      };

      const metaPath = ProfileManager.SYNC_METADATA_PATH;
      const metaDir = path.dirname(metaPath);

      // Ensure parent directory exists
      if (!fs.existsSync(metaDir)) {
        fs.mkdirSync(metaDir, { recursive: true });
      }

      // Atomic write: write to temp file, then rename
      const tmpPath = `${metaPath}.tmp-${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf8');
      fs.renameSync(tmpPath, metaPath);
    } catch (err) {
      console.error('[ProfileManager] updateSyncMetadata failed (non-fatal):', err);
    }
  }

  /**
   * Determine which Chrome `userDataDir` to use and whether a cookie sync
   * was performed.
   *
   * Priority order:
   * 1. `explicitUserDataDir` — caller has specified an exact directory.
   * 2. `useTempProfile` or `usingHeadlessShell` — create a fresh temp dir.
   * 3. `realProfileDir` exists and **not** locked — use real profile directly.
   * 4. `realProfileDir` exists and **is** locked — use persistent profile,
   *    syncing cookies from the real profile when stale.
   * 5. No `realProfileDir` — use persistent profile without a sync.
   */
  resolveProfile(options: {
    realProfileDir: string | null;
    isProfileLocked: boolean;
    explicitUserDataDir?: string;
    useTempProfile?: boolean;
    usingHeadlessShell?: boolean;
  }): ProfileResolution {
    const {
      realProfileDir,
      isProfileLocked,
      explicitUserDataDir,
      useTempProfile,
      usingHeadlessShell,
    } = options;

    // 1. Explicit user-data-dir
    if (explicitUserDataDir) {
      return {
        userDataDir: explicitUserDataDir,
        profileType: 'explicit',
        syncPerformed: false,
      };
    }

    // 2. Temp profile requested or headless-shell (no profile support)
    if (useTempProfile || usingHeadlessShell) {
      const tempDir = path.join(os.tmpdir(), `openchrome-${Date.now()}`);
      return {
        userDataDir: tempDir,
        profileType: 'temp',
        syncPerformed: false,
      };
    }

    // 3. Real profile available and NOT locked
    if (realProfileDir && !isProfileLocked) {
      return {
        userDataDir: realProfileDir,
        profileType: 'real',
        syncPerformed: false,
      };
    }

    // 4. Real profile exists but IS locked — use persistent profile
    if (realProfileDir && isProfileLocked) {
      const persistentDir = this.getOrCreatePersistentProfile();

      if (!this.needsSync(realProfileDir)) {
        // Persistent profile is fresh — reuse without re-sync
        return {
          userDataDir: persistentDir,
          profileType: 'persistent',
          syncPerformed: false,
        };
      }

      // Stale — sync cookies from real profile into persistent profile
      const syncResult = this.syncCookies(realProfileDir, persistentDir);
      return {
        userDataDir: persistentDir,
        profileType: 'persistent',
        syncPerformed: syncResult.atomic || syncResult.success,
      };
    }

    // 5. No real profile at all — use persistent profile (no sync needed)
    const persistentDir = this.getOrCreatePersistentProfile();
    return {
      userDataDir: persistentDir,
      profileType: 'persistent',
      syncPerformed: false,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Check whether the `sqlite3` CLI is available on PATH. */
  private _isSqlite3Available(): boolean {
    try {
      execFileSync(
        os.platform() === 'win32' ? 'where' : 'which',
        ['sqlite3'],
        { stdio: 'ignore', timeout: 3000 },
      );
      return true;
    } catch {
      return false;
    }
  }
}
