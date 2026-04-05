/**
 * Main recorder class for the Session Recording & Replay subsystem.
 * Wraps RecordingStore and handles action capture, screenshot capture,
 * and arg sanitization.
 * Part of #572: Session Recording & Replay.
 */

import { randomBytes } from 'crypto';
import { RecordingStore, getRecordingStore } from './recording-store';
import { RecordingAction, RecordingMetadata, RecordingConfig, DEFAULT_RECORDING_CONFIG } from './types';

/** Arg keys that are always redacted */
const REDACT_KEYS = /password|token|secret|credential|api[_-]?key/i;

/** Screenshot timeout in milliseconds */
const SCREENSHOT_TIMEOUT_MS = 5000;

/**
 * Generate a unique recording ID.
 * Format: rec-YYYYMMDD-HHMMSS-xxxx
 */
export function generateRecordingId(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hour = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  const sec = String(now.getUTCSeconds()).padStart(2, '0');
  const rand = randomBytes(3).toString('hex');
  return `rec-${year}${month}${day}-${hour}${min}${sec}-${rand}`;
}

/**
 * Options for starting a new recording.
 */
export interface StartRecordingOptions {
  /** Optional user-supplied label */
  label?: string;
  /** Browser profile name */
  profile?: string;
}

/**
 * Options for recording a single action.
 */
export interface RecordActionOptions {
  /** Target tab identifier */
  tabId?: string;
  /** Human-readable 1-line summary */
  summary?: string;
  /** URL at time of action */
  url?: string;
  /** Error message (when ok=false) */
  error?: string;
}

/**
 * Manages recording of MCP tool calls to disk.
 */
export class ActionRecorder {
  private readonly store: RecordingStore;
  private readonly config: RecordingConfig;
  private _isRecording = false;
  private _activeRecordingId: string | null = null;
  private _activeMetadata: RecordingMetadata | null = null;
  private _seq = 0;

  constructor(store?: RecordingStore, configOverrides?: Partial<RecordingConfig>) {
    this.store = store ?? getRecordingStore();
    this.config = { ...DEFAULT_RECORDING_CONFIG, ...configOverrides };
  }

  /** Whether a recording is currently active */
  get isRecording(): boolean {
    return this._isRecording;
  }

  /** The active recording ID, or null if not recording */
  get activeRecordingId(): string | null {
    return this._activeRecordingId;
  }

  /** A snapshot copy of the active recording metadata, or null if not recording */
  get activeMetadata(): RecordingMetadata | null {
    if (!this._activeMetadata) return null;
    return { ...this._activeMetadata };
  }

  /**
   * Start a new recording session.
   * Throws if a recording is already active.
   */
  async start(sessionId: string, opts?: StartRecordingOptions): Promise<RecordingMetadata> {
    if (this._isRecording) {
      throw new Error('A recording is already active. Call stop() first.');
    }

    const id = generateRecordingId();
    const metadata: RecordingMetadata = {
      version: 1,
      id,
      sessionId,
      startedAt: new Date().toISOString(),
      actionCount: 0,
      profile: opts?.profile,
      label: opts?.label,
    };

    await this.store.init();
    await this.store.createRecording(metadata);

    this._activeMetadata = metadata;
    this._activeRecordingId = id;
    this._isRecording = true;
    this._seq = 0;

    return { ...metadata };
  }

  /**
   * Stop the active recording and finalize metadata.
   * Throws if no recording is active.
   */
  async stop(): Promise<RecordingMetadata> {
    if (!this._isRecording || !this._activeMetadata || !this._activeRecordingId) {
      throw new Error('No active recording. Call start() first.');
    }

    const metadata: RecordingMetadata = {
      ...this._activeMetadata,
      stoppedAt: new Date().toISOString(),
    };

    await this.store.writeMetadata(metadata);

    // Reset state
    this._isRecording = false;
    this._activeMetadata = null;
    this._activeRecordingId = null;
    this._seq = 0;

    return metadata;
  }

  /**
   * Record a single tool action. No-op if not currently recording.
   */
  async recordAction(
    tool: string,
    args: Record<string, unknown>,
    durationMs: number,
    ok: boolean,
    opts?: RecordActionOptions,
  ): Promise<void> {
    if (!this._isRecording || !this._activeRecordingId || !this._activeMetadata) {
      return;
    }

    const id = this._activeRecordingId;

    try {
      const seq = this._seq + 1;
      const action: RecordingAction = {
        seq,
        ts: Date.now(),
        tool,
        args: this.sanitizeArgs(args),
        durationMs,
        ok,
        summary: opts?.summary ?? `${ok ? '✓' : '✗'} ${tool}`,
        url: opts?.url,
        tabId: opts?.tabId ?? (args['tabId'] as string | undefined),
        error: opts?.error,
      };

      this.store.appendAction(id, action);

      // Only advance seq and actionCount after successful write
      this._seq = seq;
      this._activeMetadata.actionCount = seq;
    } catch (err) {
      console.error('[ActionRecorder] Failed to record action:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Capture a screenshot and save it to the active recording.
   * Returns the filename on success, or null on failure.
   * No-op if not recording or screenshots are disabled.
   */
  async captureScreenshot(phase: 'before' | 'after', tabId?: string): Promise<string | null> {
    if (!this._isRecording || !this._activeRecordingId) return null;
    if (!this.config.captureScreenshots) return null;
    if (!tabId) return null;

    try {
      const { getSessionManager } = await import('../session-manager');
      const sessionManager = getSessionManager();

      let timer1: ReturnType<typeof setTimeout> | undefined;
      const page = await Promise.race([
        sessionManager.getPage(this._activeMetadata!.sessionId, tabId),
        new Promise<null>((_, reject) => {
          timer1 = setTimeout(() => reject(new Error('Screenshot page lookup timed out')), SCREENSHOT_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer1));

      if (!page) return null;

      let timer2: ReturnType<typeof setTimeout> | undefined;
      const buf = await Promise.race([
        page.screenshot({
          type: this.config.screenshotFormat === 'png' ? 'png' : this.config.screenshotFormat,
          quality: this.config.screenshotFormat !== 'png' ? this.config.screenshotQuality : undefined,
        }),
        new Promise<null>((_, reject) => {
          timer2 = setTimeout(() => reject(new Error('Screenshot capture timed out')), SCREENSHOT_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer2));

      if (!buf) return null;

      const ext = this.config.screenshotFormat;
      const filename = `screenshot-${this._seq}-${phase}.${ext}`;
      await this.store.saveScreenshot(this._activeRecordingId, filename, Buffer.from(buf));
      return filename;
    } catch {
      // Screenshot capture is best-effort — never crash the server
      return null;
    }
  }

  /**
   * Sanitize sensitive arguments before recording.
   */
  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (REDACT_KEYS.test(k)) {
        sanitized[k] = '[REDACTED]';
      } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        sanitized[k] = this.sanitizeArgs(v as Record<string, unknown>);
      } else {
        sanitized[k] = v;
      }
    }
    return sanitized;
  }
}

/** Singleton instance */
let instance: ActionRecorder | null = null;

/**
 * Get the singleton ActionRecorder instance.
 */
export function getActionRecorder(): ActionRecorder {
  if (!instance) {
    instance = new ActionRecorder();
  }
  return instance;
}
