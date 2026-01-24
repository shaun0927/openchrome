/**
 * Config Recovery System
 * Automatic backup, corruption detection, and recovery for .claude.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  writeFileAtomicSafe,
  readFileSafe,
  backupFile,
  listBackups,
  restoreFromBackup,
  cleanupBackups,
} from '../utils/atomic-file';
import {
  detectCorruption,
  extractValidJson,
  validateClaudeConfig,
  ValidationResult,
} from '../utils/json-validator';
import { getClaudeConfigPath } from './session-isolator';

export interface RecoveryReport {
  success: boolean;
  action: 'none' | 'recovered' | 'restored_backup' | 'created_new';
  originalError?: string;
  recoveryMethod?: string;
  backupCreated?: string;
  details?: string;
}

export interface WatcherOptions {
  /** Check interval in ms (default: 5000) */
  interval?: number;
  /** Auto-recover on corruption (default: true) */
  autoRecover?: boolean;
  /** Callback on corruption detected */
  onCorruption?: (validation: ValidationResult) => void;
  /** Callback on recovery */
  onRecovery?: (report: RecoveryReport) => void;
}

/**
 * Create an automatic backup of .claude.json
 * Should be called before any risky operation
 */
export async function createBackup(): Promise<string | null> {
  const configPath = getClaudeConfigPath();

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    return await backupFile(configPath);
  } catch (error) {
    console.error('Failed to create backup:', (error as Error).message);
    return null;
  }
}

/**
 * Recover corrupted .claude.json
 * Attempts multiple recovery strategies
 */
export async function recoverConfig(): Promise<RecoveryReport> {
  const configPath = getClaudeConfigPath();

  // Check if file exists
  if (!fs.existsSync(configPath)) {
    return {
      success: true,
      action: 'none',
      details: 'No config file to recover',
    };
  }

  // Read and validate current config
  const content = fs.readFileSync(configPath, 'utf8');
  const validation = detectCorruption(content);

  // If valid, nothing to do
  if (validation.valid) {
    return {
      success: true,
      action: 'none',
      details: 'Config is valid, no recovery needed',
    };
  }

  // Create backup before attempting recovery
  let backupPath: string | null = null;
  try {
    backupPath = await backupFile(configPath);
  } catch {
    // Continue without backup
  }

  // Strategy 1: Try to extract valid JSON from corrupted content
  const extraction = extractValidJson(content);
  if (extraction.success && extraction.data) {
    // Validate the extracted data looks like a Claude config
    const configValidation = validateClaudeConfig(extraction.data);
    if (configValidation.valid) {
      await writeFileAtomicSafe(configPath, extraction.data);
      return {
        success: true,
        action: 'recovered',
        originalError: validation.error,
        recoveryMethod: extraction.method,
        backupCreated: backupPath ?? undefined,
        details: `Recovered using ${extraction.method}`,
      };
    }
  }

  // Strategy 2: Restore from most recent backup
  const backups = listBackups('.claude.json');
  if (backups.length > 0) {
    const backupDir = path.join(
      os.homedir(),
      '.claude-chrome-parallel',
      'backups'
    );

    for (const backup of backups) {
      const backupFilePath = path.join(backupDir, backup);
      const readResult = await readFileSafe(backupFilePath);

      if (readResult.success && readResult.data) {
        const configValidation = validateClaudeConfig(readResult.data);
        if (configValidation.valid) {
          await restoreFromBackup(backupFilePath, configPath);
          return {
            success: true,
            action: 'restored_backup',
            originalError: validation.error,
            recoveryMethod: `restored from backup: ${backup}`,
            backupCreated: backupPath ?? undefined,
            details: `Restored from ${backup}`,
          };
        }
      }
    }
  }

  // Strategy 3: Create new empty config
  await writeFileAtomicSafe(configPath, {});
  return {
    success: true,
    action: 'created_new',
    originalError: validation.error,
    recoveryMethod: 'created_new_empty_config',
    backupCreated: backupPath ?? undefined,
    details: 'Created new empty config (all previous data lost)',
  };
}

/**
 * Restore from a specific backup
 */
export async function recoverFromBackup(
  backupName?: string
): Promise<RecoveryReport> {
  const configPath = getClaudeConfigPath();
  const backupDir = path.join(
    os.homedir(),
    '.claude-chrome-parallel',
    'backups'
  );
  const backups = listBackups('.claude.json');

  if (backups.length === 0) {
    return {
      success: false,
      action: 'none',
      details: 'No backups available',
    };
  }

  // Use specified backup or most recent
  const targetBackup = backupName || backups[0];
  const backupPath = path.join(backupDir, targetBackup);

  if (!fs.existsSync(backupPath)) {
    return {
      success: false,
      action: 'none',
      details: `Backup not found: ${targetBackup}`,
    };
  }

  // Validate backup content
  const readResult = await readFileSafe(backupPath);
  if (!readResult.success || !readResult.data) {
    return {
      success: false,
      action: 'none',
      details: `Backup is corrupted: ${targetBackup}`,
    };
  }

  // Create backup of current (corrupted) file
  let currentBackup: string | null = null;
  if (fs.existsSync(configPath)) {
    try {
      currentBackup = await backupFile(configPath);
    } catch {
      // Continue without backup
    }
  }

  // Restore
  await restoreFromBackup(backupPath, configPath);

  return {
    success: true,
    action: 'restored_backup',
    recoveryMethod: `manual restore from ${targetBackup}`,
    backupCreated: currentBackup ?? undefined,
    details: `Restored from ${targetBackup}`,
  };
}

/**
 * Watch for corruption and auto-recover
 */
export function watchForCorruption(
  options: WatcherOptions = {}
): { stop: () => void } {
  const {
    interval = 5000,
    autoRecover = true,
    onCorruption,
    onRecovery,
  } = options;

  let lastContent: string | null = null;
  let stopped = false;

  const check = async () => {
    if (stopped) return;

    const configPath = getClaudeConfigPath();

    if (!fs.existsSync(configPath)) {
      lastContent = null;
      return;
    }

    try {
      const content = fs.readFileSync(configPath, 'utf8');

      // Skip if content hasn't changed
      if (content === lastContent) {
        return;
      }

      lastContent = content;

      // Check for corruption
      const validation = detectCorruption(content);

      if (!validation.valid && validation.corrupted) {
        onCorruption?.(validation);

        if (autoRecover) {
          const report = await recoverConfig();
          onRecovery?.(report);
        }
      }
    } catch (error) {
      // File might be in use, skip this check
    }
  };

  // Initial check
  check();

  // Start interval
  const intervalId = setInterval(check, interval);

  return {
    stop: () => {
      stopped = true;
      clearInterval(intervalId);
    },
  };
}

/**
 * Get recovery status
 */
export async function getRecoveryStatus(): Promise<{
  configExists: boolean;
  configHealthy: boolean;
  error?: string;
  backupsAvailable: number;
  oldestBackup?: string;
  newestBackup?: string;
}> {
  const configPath = getClaudeConfigPath();
  const backups = listBackups('.claude.json');

  const status: {
    configExists: boolean;
    configHealthy: boolean;
    error?: string;
    backupsAvailable: number;
    oldestBackup?: string;
    newestBackup?: string;
  } = {
    configExists: fs.existsSync(configPath),
    configHealthy: false,
    backupsAvailable: backups.length,
    oldestBackup: backups[backups.length - 1],
    newestBackup: backups[0],
  };

  if (status.configExists) {
    const content = fs.readFileSync(configPath, 'utf8');
    const validation = detectCorruption(content);
    status.configHealthy = validation.valid;
    if (!validation.valid) {
      status.error = validation.error;
    }
  } else {
    status.configHealthy = true; // No config is technically healthy
  }

  return status;
}

/**
 * Perform maintenance: cleanup old backups
 */
export function performMaintenance(keepBackups: number = 10): {
  backupsRemoved: number;
} {
  const removed = cleanupBackups('.claude.json', keepBackups);
  return { backupsRemoved: removed };
}

/**
 * Force a backup now (manual trigger)
 */
export async function forceBackup(): Promise<{
  success: boolean;
  path?: string;
  error?: string;
}> {
  try {
    const backupPath = await createBackup();
    if (backupPath) {
      return { success: true, path: backupPath };
    }
    return { success: false, error: 'No config file to backup' };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}
