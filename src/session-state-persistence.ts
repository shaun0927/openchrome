/**
 * Session State Persistence — serializes session/worker/target mappings to disk.
 * Enables recovery of MCP server state after process restart.
 * Part of #347 Layer 2: Session State Persistence.
 *
 * Integration plan:
 * SessionManager should instantiate SessionStatePersistence and call:
 *   - scheduleSave(createSnapshot(this.sessions)) on every mutation
 *     (worker/target created or deleted)
 *   - restore() on startup to reload prior state
 *   - clear() on clean shutdown (e.g., SIGTERM handler)
 * Until that wiring lands this module is compiled but not invoked at runtime.
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
  private readonly maxStalenessMs: number;
  private readonly filePath: string;
  private saving = false;
  private pendingSave = false;
  private lastState: PersistedSessionState | null = null;

  constructor(opts?: { dir?: string; debounceMs?: number; maxStalenessMs?: number }) {
    this.debounceMs = opts?.debounceMs ?? 5000;
    this.maxStalenessMs = opts?.maxStalenessMs ?? 24 * 60 * 60 * 1000; // 24h default
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
   * If a save is already in progress, the latest state is queued and written
   * once the current write completes — no state is silently dropped.
   */
  async save(state: PersistedSessionState): Promise<void> {
    if (this.saving) {
      this.pendingSave = true;
      this.lastState = state;
      return;
    }
    this.saving = true;
    try {
      await writeFileAtomicSafe(this.filePath, { ...state, timestamp: Date.now() });
    } finally {
      this.saving = false;
      if (this.pendingSave && this.lastState) {
        this.pendingSave = false;
        const next = this.lastState;
        this.lastState = null;
        await this.save(next);
      }
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

    // Check staleness
    if (state.timestamp) {
      const age = Date.now() - state.timestamp;
      if (age > this.maxStalenessMs) {
        console.error(
          `[SessionStatePersistence] Stale snapshot (${Math.round(age / 3600000)}h old, max ${Math.round(this.maxStalenessMs / 3600000)}h), ignoring`
        );
        return null;
      }
    }

    return state;
  }

  /**
   * Delete persisted state file (e.g., on clean shutdown).
   * Only ENOENT is swallowed; other errors (e.g., permission failures) are logged.
   */
  async clear(): Promise<void> {
    const fs = await import('fs/promises');
    try {
      await fs.unlink(this.filePath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        console.error(`[SessionStatePersistence] Failed to clear state: ${error.message}`);
      }
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
   *
   * Workers hold targets as Set<string> (bare CDP target IDs). URLs are not
   * tracked in memory — persisted entries use 'about:blank' as a placeholder.
   */
  static createSnapshot(sessions: Map<string, {
    workers: Map<string, { id: string; targets: Set<string> }>;
    lastActivityAt: number;
  }>): PersistedSessionState {
    const persistedSessions: PersistedSession[] = [];

    for (const [sessionId, session] of sessions) {
      const workers: PersistedWorker[] = [];
      for (const [, worker] of session.workers) {
        const targets: PersistedTarget[] = [];
        for (const targetId of worker.targets) {
          targets.push({ targetId, url: 'about:blank' });
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
