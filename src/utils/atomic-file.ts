/**
 * Atomic file operations for safe concurrent access
 * Prevents race conditions when multiple processes access the same file
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import writeFileAtomic from 'write-file-atomic';
import * as lockfile from 'proper-lockfile';

export interface WriteOptions {
  /** Create backup before writing */
  backup?: boolean;
  /** Timeout for acquiring lock (ms) */
  lockTimeout?: number;
}

export interface ReadResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  corrupted?: boolean;
}

/**
 * Write file atomically using temp file + rename pattern
 * This ensures the file is never in a partial/corrupt state
 */
export async function writeFileAtomicSafe(
  filePath: string,
  data: string | object,
  options: WriteOptions = {}
): Promise<void> {
  const { backup = false, lockTimeout = 10000 } = options;
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create backup if requested and file exists
  if (backup && fs.existsSync(filePath)) {
    await backupFile(filePath);
  }

  // Use write-file-atomic for safe writing
  await writeFileAtomic(filePath, content, { encoding: 'utf8' });
}

/**
 * Read file safely with JSON validation
 */
export async function readFileSafe<T = unknown>(
  filePath: string
): Promise<ReadResult<T>> {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File does not exist' };
    }

    const content = fs.readFileSync(filePath, 'utf8');

    // Try to parse as JSON
    try {
      const data = JSON.parse(content) as T;
      return { success: true, data };
    } catch (parseError) {
      // Check if it's a corruption pattern (two JSON objects concatenated)
      if (content.includes('}{')) {
        return {
          success: false,
          error: 'JSON parse error - corruption detected',
          corrupted: true,
        };
      }
      return {
        success: false,
        error: `JSON parse error: ${(parseError as Error).message}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: `Read error: ${(error as Error).message}`,
    };
  }
}

/**
 * Create a backup of a file
 */
export async function backupFile(
  filePath: string,
  backupDir?: string
): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  // Default backup directory
  const defaultBackupDir = path.join(
    os.homedir(),
    '.openchrome',
    'backups'
  );
  const targetDir = backupDir || defaultBackupDir;

  // Ensure backup directory exists
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Generate backup filename with timestamp
  const basename = path.basename(filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${basename}.${timestamp}.bak`;
  const backupPath = path.join(targetDir, backupName);

  // Copy file to backup location
  fs.copyFileSync(filePath, backupPath);

  return backupPath;
}

/**
 * Restore a file from backup
 */
export async function restoreFromBackup(
  backupPath: string,
  targetPath: string
): Promise<void> {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file does not exist: ${backupPath}`);
  }

  // Ensure target directory exists
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Use atomic write to restore
  const content = fs.readFileSync(backupPath, 'utf8');
  await writeFileAtomicSafe(targetPath, content);
}

/**
 * Get list of available backups for a file
 */
export function listBackups(
  originalFilename: string,
  backupDir?: string
): string[] {
  const defaultBackupDir = path.join(
    os.homedir(),
    '.openchrome',
    'backups'
  );
  const targetDir = backupDir || defaultBackupDir;

  if (!fs.existsSync(targetDir)) {
    return [];
  }

  const basename = path.basename(originalFilename);
  const pattern = new RegExp(`^${basename.replace('.', '\\.')}\\..*\\.bak$`);

  return fs
    .readdirSync(targetDir)
    .filter((file) => pattern.test(file))
    .sort()
    .reverse(); // Most recent first
}

/**
 * Clean up old backups, keeping only the specified number
 */
export function cleanupBackups(
  originalFilename: string,
  keepCount: number = 5,
  backupDir?: string
): number {
  const backups = listBackups(originalFilename, backupDir);
  const toDelete = backups.slice(keepCount);

  const defaultBackupDir = path.join(
    os.homedir(),
    '.openchrome',
    'backups'
  );
  const targetDir = backupDir || defaultBackupDir;

  for (const backup of toDelete) {
    const backupPath = path.join(targetDir, backup);
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // Ignore deletion errors
    }
  }

  return toDelete.length;
}

/**
 * Acquire a file lock with timeout
 */
export async function acquireLock(
  filePath: string,
  timeout: number = 10000
): Promise<() => Promise<void>> {
  // Ensure file exists for locking
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '{}');
  }

  const release = await lockfile.lock(filePath, {
    retries: {
      retries: Math.ceil(timeout / 100),
      factor: 1,
      minTimeout: 100,
      maxTimeout: 100,
    },
  });

  return release;
}

/**
 * Check if a file is currently locked
 */
export async function isLocked(filePath: string): Promise<boolean> {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  return lockfile.check(filePath);
}
