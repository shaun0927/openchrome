#!/usr/bin/env node
/**
 * Claude Session - Standalone wrapper for running Claude Code in isolated environments
 *
 * Usage:
 *   claude-session [claude-args...]     - Start Claude Code with isolated config
 *   claude-session --list               - List active sessions
 *   claude-session --cleanup            - Clean up stale sessions
 *   claude-session --recover            - Recover corrupted .claude.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

const BASE_DIR = path.join(os.homedir(), '.openchrome');
const SESSIONS_DIR = path.join(BASE_DIR, 'sessions');
const BACKUPS_DIR = path.join(BASE_DIR, 'backups');

interface SessionMetadata {
  id: string;
  createdAt: string;
  originalHome: string;
  pid?: number;
}

/**
 * Generate unique session ID
 */
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * Check if JSON is valid
 */
function isValidJson(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create backup of config
 */
function createBackup(configPath: string): string | null {
  if (!fs.existsSync(configPath)) return null;

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUPS_DIR, `.claude.json.${timestamp}.bak`);

  fs.copyFileSync(configPath, backupPath);
  return backupPath;
}

/**
 * List all sessions
 */
function listSessions(): SessionMetadata[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];

  const sessions: SessionMetadata[] = [];
  const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const metadataPath = path.join(SESSIONS_DIR, entry.name, '.session-metadata.json');
    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        sessions.push(metadata);
      } catch {
        // Skip invalid metadata
      }
    }
  }

  return sessions.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Cleanup stale sessions
 */
function cleanupSessions(maxAgeHours: number = 24): number {
  if (!fs.existsSync(SESSIONS_DIR)) return 0;

  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();
  let removed = 0;

  const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const sessionDir = path.join(SESSIONS_DIR, entry.name);
    const metadataPath = path.join(sessionDir, '.session-metadata.json');

    let shouldDelete = false;

    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const age = now - new Date(metadata.createdAt).getTime();
        shouldDelete = age > maxAgeMs;
      } catch {
        shouldDelete = true;
      }
    } else {
      shouldDelete = true;
    }

    if (shouldDelete) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      removed++;
    }
  }

  return removed;
}

/**
 * Recover corrupted config
 */
function recoverConfig(): boolean {
  const configPath = path.join(os.homedir(), '.claude.json');

  if (!fs.existsSync(configPath)) {
    console.log('No .claude.json found - nothing to recover');
    return true;
  }

  const content = fs.readFileSync(configPath, 'utf8');

  if (isValidJson(content)) {
    console.log('Config is valid - no recovery needed');
    return true;
  }

  console.log('Config is corrupted - attempting recovery...');

  // Backup corrupted file
  createBackup(configPath);

  // Try to extract valid JSON from concatenated content
  if (content.includes('}{')) {
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          const firstObject = content.substring(0, i + 1);
          try {
            JSON.parse(firstObject);
            fs.writeFileSync(configPath, firstObject);
            console.log('Recovered first JSON object');
            return true;
          } catch {
            const secondObject = content.substring(i + 1);
            try {
              JSON.parse(secondObject);
              fs.writeFileSync(configPath, secondObject);
              console.log('Recovered second JSON object');
              return true;
            } catch {
              break;
            }
          }
        }
      }
    }
  }

  // Try to restore from backup
  if (fs.existsSync(BACKUPS_DIR)) {
    const backups = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith('.claude.json.'))
      .sort()
      .reverse();

    for (const backup of backups) {
      const backupContent = fs.readFileSync(path.join(BACKUPS_DIR, backup), 'utf8');
      if (isValidJson(backupContent)) {
        fs.writeFileSync(configPath, backupContent);
        console.log(`Restored from backup: ${backup}`);
        return true;
      }
    }
  }

  // Last resort: create empty config
  fs.writeFileSync(configPath, '{}');
  console.log('Created new empty config (backup of corrupted file saved)');
  return true;
}

/**
 * Start Claude Code with isolated config
 */
function startIsolatedSession(claudeArgs: string[]): void {
  const sessionId = generateSessionId();
  const sessionDir = path.join(SESSIONS_DIR, sessionId);

  console.log(`Session: ${sessionId}`);

  // Create session directory
  fs.mkdirSync(sessionDir, { recursive: true });

  // Copy existing config
  const originalConfig = path.join(os.homedir(), '.claude.json');
  const sessionConfig = path.join(sessionDir, '.claude.json');

  if (fs.existsSync(originalConfig)) {
    const content = fs.readFileSync(originalConfig, 'utf8');
    if (isValidJson(content)) {
      fs.copyFileSync(originalConfig, sessionConfig);
    } else {
      console.warn('Warning: Original config corrupted, starting fresh');
      fs.writeFileSync(sessionConfig, '{}');
    }
  } else {
    fs.writeFileSync(sessionConfig, '{}');
  }

  // Create metadata
  const metadata: SessionMetadata = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    originalHome: os.homedir(),
    pid: process.pid,
  };
  fs.writeFileSync(
    path.join(sessionDir, '.session-metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  console.log('Starting Claude Code...\n');

  // Set up isolated environment
  const env = {
    ...process.env,
    HOME: sessionDir,
    USERPROFILE: sessionDir,
    CLAUDE_CONFIG_DIR: sessionDir,
  };

  // Start Claude
  const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const child = spawn(claudeCmd, claudeArgs, {
    env,
    stdio: 'inherit',
    shell: true,
  });

  // Cleanup on exit
  const cleanup = () => {
    console.log('\nCleaning up session...');
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  };

  child.on('close', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

// Main
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Claude Session - Run Claude Code with isolated config

Usage:
  claude-session [claude-args...]     Start Claude Code with isolated config
  claude-session --list               List active sessions
  claude-session --cleanup [hours]    Clean up sessions older than N hours (default: 24)
  claude-session --recover            Recover corrupted .claude.json
  claude-session --help               Show this help

Examples:
  claude-session                      Start interactive session
  claude-session "Fix the bug"        Start with prompt
  claude-session --list               Show active sessions
  claude-session --cleanup 12         Clean up sessions older than 12 hours
`);
  process.exit(0);
}

if (args.includes('--list')) {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log('No active sessions');
  } else {
    console.log(`Active sessions (${sessions.length}):\n`);
    for (const session of sessions) {
      const age = Date.now() - new Date(session.createdAt).getTime();
      const ageStr = age < 60000
        ? `${Math.floor(age / 1000)}s ago`
        : age < 3600000
        ? `${Math.floor(age / 60000)}m ago`
        : `${Math.floor(age / 3600000)}h ago`;
      console.log(`  ${session.id} (${ageStr})`);
    }
  }
  process.exit(0);
}

if (args.includes('--cleanup')) {
  const hoursIndex = args.indexOf('--cleanup') + 1;
  const hours = hoursIndex < args.length ? parseInt(args[hoursIndex], 10) || 24 : 24;
  const removed = cleanupSessions(hours);
  console.log(`Cleaned up ${removed} stale session(s)`);
  process.exit(0);
}

if (args.includes('--recover')) {
  recoverConfig();
  process.exit(0);
}

// Start isolated session
startIsolatedSession(args);
