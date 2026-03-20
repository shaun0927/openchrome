/**
 * Session State Persistence — serializes session/worker/target mappings to disk.
 * Enables recovery of MCP server state after process restart.
 * Part of #347 Layer 2: Session State Persistence.
 */

import * as path from 'path';
import * as os from 'os';
import { writeFileAtomicSafe, readFileSafe } from './utils/atomic-file';

export interface PersistedTarget {
  targetId: string;
  url: string;
}

export interface PersistedWorker {
  id: string;
  targets: PersistedTarget[];
}

export interface PersistedSession {
  id: string;
  workers: PersistedWorker[];
  lastActivityAt: number;
}

export interface PersistedSessionState {
  version: 1;
  timestamp: number;
  sessions: PersistedSession[];
}

export class SessionStatePersistence {
  private saveDebounceTimer: NodeJS.Timeout | null = null;
  private readonly debounceMs: number;
  private readonly filePath: string;
  private saving = false;

  constructor(opts?: { dir?: string; debounceMs?: number }) {
    this.debounceMs = opts?.debounceMs ?? 5000;
    const dir = opts?.dir || path.join(os.homedir(), '.openchrome');
    this.filePath = path.join(dir, 'session-state.json');
  }

  /**
   * Schedule a debounced save. Multiple calls within debounceMs are coalesced.
   */
  scheduleSave(state: PersistedSessionState): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(async () => {
      this.saveDebounceTimer = null;
      await this.save(state);
    }, this.debounceMs);
    // Don't prevent process exit
    if (this.saveDebounceTimer.unref) {
      this.saveDebounceTimer.unref();
    }
  }

  /**
   * Immediately save state to disk.
   */
  async save(state: PersistedSessionState): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      const stateWithTimestamp: PersistedSessionState = {
        ...state,
        timestamp: Date.now(),
      };
      await writeFileAtomicSafe(this.filePath, stateWithTimestamp);
    } finally {
      this.saving = false;
    }
  }

  /**
   * Restore state from disk.
   * Returns null if file doesn't exist, is corrupted, or has wrong version.
   */
  async restore(): Promise<PersistedSessionState | null> {
    const result = await readFileSafe<PersistedSessionState>(this.filePath);
    if (!result.success || !result.data) {
      return null;
    }

    const state = result.data;

    // Validate version
    if (state.version !== 1) {
      console.error(`[SessionStatePersistence] Unknown version: ${state.version}, ignoring`);
      return null;
    }

    // Validate structure
    if (!Array.isArray(state.sessions)) {
      console.error('[SessionStatePersistence] Invalid state: sessions is not an array');
      return null;
    }

    return state;
  }

  /**
   * Delete persisted state file (e.g., on clean shutdown).
   */
  async clear(): Promise<void> {
    const fs = await import('fs/promises');
    try {
      await fs.unlink(this.filePath);
    } catch {
      // File may not exist — that's fine
    }
  }

  /**
   * Cancel any pending debounced save.
   */
  cancelPendingSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
  }

  /**
   * Whether a save is currently in progress.
   */
  isSaving(): boolean {
    return this.saving;
  }

  /**
   * Get the file path where state is persisted.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Helper: extract session state from SessionManager's in-memory structures.
   * This is a pure function that converts the internal format to persisted format.
   */
  static createSnapshot(sessions: Map<string, {
    workers: Map<string, { id: string; targets: Map<string, { url?: string }> }>;
    lastActivityAt: number;
  }>): PersistedSessionState {
    const persistedSessions: PersistedSession[] = [];

    for (const [sessionId, session] of sessions) {
      const workers: PersistedWorker[] = [];
      for (const [, worker] of session.workers) {
        const targets: PersistedTarget[] = [];
        for (const [targetId, targetInfo] of worker.targets) {
          targets.push({
            targetId,
            url: targetInfo.url || 'about:blank',
          });
        }
        workers.push({ id: worker.id, targets });
      }
      persistedSessions.push({
        id: sessionId,
        workers,
        lastActivityAt: session.lastActivityAt,
      });
    }

    return {
      version: 1,
      timestamp: Date.now(),
      sessions: persistedSessions,
    };
  }
}
