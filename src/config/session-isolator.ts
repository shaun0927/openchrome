/**
 * Session Isolator
 * Creates isolated configuration environments for each Claude Code session
 * Prevents race conditions by giving each session its own config directory
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { writeFileAtomicSafe, readFileSafe, backupFile } from '../utils/atomic-file';
import { detectCorruption, extractValidJson } from '../utils/json-validator';

export interface IsolatedSession {
  /** Unique session identifier */
  id: string;
  /** Path to isolated config directory */
  configDir: string;
  /** Path to the .claude.json in isolated directory */
  claudeConfigPath: string;
  /** Original HOME directory */
  originalHome: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Session metadata */
  metadata?: Record<string, unknown>;
}

export interface SessionIsolatorOptions {
  /** Base directory for sessions (defaults to ~/.claude-chrome-parallel/sessions) */
  baseDir?: string;
  /** Whether to copy existing config (defaults to true) */
  copyExistingConfig?: boolean;
  /** Maximum age for stale sessions in ms (defaults to 24 hours) */
  maxSessionAge?: number;
}

const DEFAULT_OPTIONS: Required<SessionIsolatorOptions> = {
  baseDir: path.join(os.homedir(), '.claude-chrome-parallel', 'sessions'),
  copyExistingConfig: true,
  maxSessionAge: 24 * 60 * 60 * 1000, // 24 hours
};

/**
 * Get the path to the user's .claude.json
 */
export function getClaudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Create an isolated session environment
 * Each session gets its own directory that acts as HOME for Claude Code
 */
export async function createIsolatedSession(
  options: SessionIsolatorOptions = {}
): Promise<IsolatedSession> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sessionId = uuidv4();
  const sessionDir = path.join(opts.baseDir, sessionId);

  // Create session directory
  fs.mkdirSync(sessionDir, { recursive: true });

  const originalConfigPath = getClaudeConfigPath();
  const isolatedConfigPath = path.join(sessionDir, '.claude.json');

  // Copy existing config if it exists and option is enabled
  if (opts.copyExistingConfig && fs.existsSync(originalConfigPath)) {
    const readResult = await readFileSafe(originalConfigPath);

    if (readResult.success && readResult.data) {
      // Config is valid, copy it
      await writeFileAtomicSafe(isolatedConfigPath, readResult.data);
    } else if (readResult.corrupted) {
      // Try to recover corrupted config
      const content = fs.readFileSync(originalConfigPath, 'utf8');
      const recovery = extractValidJson(content);

      if (recovery.success && recovery.data) {
        // Create backup of corrupted file
        await backupFile(originalConfigPath);
        // Use recovered data
        await writeFileAtomicSafe(isolatedConfigPath, recovery.data);
        console.warn(
          `Warning: Recovered corrupted .claude.json using ${recovery.method}`
        );
      } else {
        // Can't recover, start fresh
        await writeFileAtomicSafe(isolatedConfigPath, {});
        console.warn('Warning: Could not recover .claude.json, starting fresh');
      }
    } else {
      // No existing config, create empty
      await writeFileAtomicSafe(isolatedConfigPath, {});
    }
  } else {
    // Create empty config
    await writeFileAtomicSafe(isolatedConfigPath, {});
  }

  // Create session metadata file
  const session: IsolatedSession = {
    id: sessionId,
    configDir: sessionDir,
    claudeConfigPath: isolatedConfigPath,
    originalHome: os.homedir(),
    createdAt: new Date(),
  };

  const metadataPath = path.join(sessionDir, '.session-metadata.json');
  await writeFileAtomicSafe(metadataPath, session);

  return session;
}

/**
 * Get the config path for a session
 */
export function getSessionConfigPath(session: IsolatedSession): string {
  return session.claudeConfigPath;
}

/**
 * Get environment variables for running Claude Code in isolated session
 */
export function getSessionEnvironment(
  session: IsolatedSession
): Record<string, string> {
  return {
    HOME: session.configDir,
    USERPROFILE: session.configDir, // Windows
    CLAUDE_CONFIG_DIR: session.configDir,
  };
}

/**
 * Clean up an isolated session
 */
export async function cleanupIsolatedSession(
  session: IsolatedSession,
  options: { syncBack?: boolean } = {}
): Promise<void> {
  const { syncBack = false } = options;

  // Optionally sync changes back to original config
  if (syncBack) {
    await syncSessionConfig(session);
  }

  // Remove session directory
  if (fs.existsSync(session.configDir)) {
    fs.rmSync(session.configDir, { recursive: true, force: true });
  }
}

/**
 * Sync session config changes back to original .claude.json
 * Uses atomic write to prevent corruption
 */
export async function syncSessionConfig(
  session: IsolatedSession
): Promise<boolean> {
  const originalPath = getClaudeConfigPath();
  const sessionPath = session.claudeConfigPath;

  if (!fs.existsSync(sessionPath)) {
    return false;
  }

  const readResult = await readFileSafe(sessionPath);
  if (!readResult.success || !readResult.data) {
    return false;
  }

  // Create backup of original before syncing
  if (fs.existsSync(originalPath)) {
    await backupFile(originalPath);
  }

  // Write session config to original location atomically
  await writeFileAtomicSafe(originalPath, readResult.data, { backup: false });

  return true;
}

/**
 * List all active sessions
 */
export function listSessions(
  options: SessionIsolatorOptions = {}
): IsolatedSession[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!fs.existsSync(opts.baseDir)) {
    return [];
  }

  const sessions: IsolatedSession[] = [];
  const entries = fs.readdirSync(opts.baseDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const metadataPath = path.join(
      opts.baseDir,
      entry.name,
      '.session-metadata.json'
    );

    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        sessions.push({
          ...metadata,
          createdAt: new Date(metadata.createdAt),
        });
      } catch {
        // Invalid metadata, skip
      }
    }
  }

  return sessions.sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
}

/**
 * Clean up stale sessions (older than maxAge)
 */
export async function cleanupStaleSessions(
  options: SessionIsolatorOptions = {}
): Promise<number> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sessions = listSessions(opts);
  const now = Date.now();
  let cleaned = 0;

  for (const session of sessions) {
    const age = now - session.createdAt.getTime();
    if (age > opts.maxSessionAge) {
      await cleanupIsolatedSession(session, { syncBack: false });
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * Get a session by ID
 */
export function getSession(
  sessionId: string,
  options: SessionIsolatorOptions = {}
): IsolatedSession | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sessionDir = path.join(opts.baseDir, sessionId);
  const metadataPath = path.join(sessionDir, '.session-metadata.json');

  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    return {
      ...metadata,
      createdAt: new Date(metadata.createdAt),
    };
  } catch {
    return null;
  }
}

/**
 * Check if original .claude.json needs recovery
 */
export async function checkOriginalConfigHealth(): Promise<{
  healthy: boolean;
  error?: string;
  suggestion?: string;
}> {
  const configPath = getClaudeConfigPath();

  if (!fs.existsSync(configPath)) {
    return {
      healthy: true,
      suggestion: 'No .claude.json found - will be created on first use',
    };
  }

  const content = fs.readFileSync(configPath, 'utf8');
  const validation = detectCorruption(content);

  if (validation.valid) {
    return { healthy: true };
  }

  return {
    healthy: false,
    error: validation.error,
    suggestion:
      validation.corruptionType === 'concatenated'
        ? 'File appears corrupted by race condition. Run recovery to fix.'
        : `File is invalid: ${validation.error}`,
  };
}
