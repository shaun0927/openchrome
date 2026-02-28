/**
 * Atomic SQLite Cookie Copy
 *
 * Chrome stores cookies in a SQLite database using WAL (Write-Ahead Log) mode.
 * The database state spans up to three files: `Cookies`, `Cookies-wal`, and
 * `Cookies-shm`. A naive sequential `fs.copyFileSync` of these files while
 * Chrome is writing produces an inconsistent copy — the main DB and WAL may
 * represent different transaction states, causing Chrome to silently discard
 * the corrupted database and start with an empty cookie jar.
 *
 * This module implements a 3-tier fallback chain for atomic cookie copying:
 *   1. `better-sqlite3` — VACUUM INTO for a clean, synchronous atomic copy
 *   2. `sqlite3` CLI — `.backup` command via child_process
 *   3. Raw `fs.copyFileSync` — last resort, copies main DB only (no WAL/SHM)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface CookieCopyResult {
  method: 'better-sqlite3' | 'sqlite3-cli' | 'file-copy' | 'none';
  success: boolean;
  warning?: string;
}

/**
 * @internal Attempt atomic copy via better-sqlite3's VACUUM INTO.
 */
function attemptBetterSqlite3Copy(sourcePath: string, destPath: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    // VACUUM INTO creates a fully checkpointed, single-file copy —
    // no WAL file is produced and no WAL file needs to be present.
    const escapedDest = destPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escapedDest}'`);
  } finally {
    db.close();
  }
}

/**
 * @internal Mutable dispatch table for testability.
 * Tests can spy on `_deps.attemptBetterSqlite3Copy` to control the fallback chain.
 */
export const _deps = {
  attemptBetterSqlite3Copy,
};

/**
 * Copy the Chrome Cookies SQLite database from one Default profile directory
 * to another using a 3-tier fallback chain for atomic consistency:
 *
 *   Tier 1: better-sqlite3 `VACUUM INTO` — synchronous, atomic, WAL-aware
 *   Tier 2: sqlite3 CLI `.backup` — atomic, WAL-aware, no npm dep required
 *   Tier 3: fs.copyFileSync — fast but non-atomic; recent WAL transactions may be absent
 *
 * @param sourceDefaultDir Path to the source Chrome `Default` profile directory
 * @param destDefaultDir Path to the destination `Default` directory (must already exist)
 * @returns Result indicating which method succeeded, or `none` if all failed
 */
export function copyCookiesAtomic(
  sourceDefaultDir: string,
  destDefaultDir: string,
): CookieCopyResult {
  const sourcePath = path.join(sourceDefaultDir, 'Cookies');
  const destPath = path.join(destDefaultDir, 'Cookies');

  // Guard: source Cookies file must exist
  if (!fs.existsSync(sourcePath)) {
    return {
      method: 'none',
      success: false,
      warning: 'Source Cookies file not found',
    };
  }

  // -------------------------------------------------------------------------
  // Tier 1: better-sqlite3 — VACUUM INTO (synchronous, atomic, WAL-aware)
  // -------------------------------------------------------------------------
  try {
    // VACUUM INTO requires the destination to not exist; remove stale file first.
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }
    _deps.attemptBetterSqlite3Copy(sourcePath, destPath);
    return { method: 'better-sqlite3', success: true };
  } catch {
    // better-sqlite3 not installed, or VACUUM INTO failed — fall through
  }

  // -------------------------------------------------------------------------
  // Tier 2: sqlite3 CLI — .backup command
  // -------------------------------------------------------------------------
  try {
    const backupCmd = process.platform === 'win32'
      ? `.backup "${destPath.replace(/"/g, '')}"`
      : `.backup '${destPath.replace(/'/g, "''")}'`;
    execFileSync('sqlite3', [sourcePath, backupCmd], {
      timeout: 5000,
      stdio: 'ignore',
    });
    return { method: 'sqlite3-cli', success: true };
  } catch {
    // sqlite3 CLI not available or backup failed — fall through
  }

  // -------------------------------------------------------------------------
  // Tier 3: Raw file copy (last resort — non-atomic, WAL not included)
  // -------------------------------------------------------------------------
  try {
    fs.copyFileSync(sourcePath, destPath);
    // Explicitly do NOT copy WAL/SHM files — an inconsistent WAL applied to
    // a partial main-db snapshot is worse than no WAL at all.
    const warning =
      'Used non-atomic file copy (sqlite3 unavailable). Some recent cookies may be missing.';
    return { method: 'file-copy', success: true, warning };
  } catch {
    const warning = 'All cookie copy methods failed.';
    return { method: 'none', success: false, warning };
  }
}
