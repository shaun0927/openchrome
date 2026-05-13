/**
 * Main recorder class for the Session Recording & Replay subsystem.
 * Wraps RecordingStore and handles action capture, screenshot capture,
 * and arg sanitization.
 * Part of #572: Session Recording & Replay.
 */

import { randomBytes } from 'crypto';
import { RecordingStore, getRecordingStore } from './recording-store';
import {
  RecordingAction,
  RecordingMetadata,
  RecordingConfig,
  DEFAULT_RECORDING_CONFIG,
  ContractResultEntry,
  NetworkEntry,
  ConsoleEntry,
} from './types';
import { TrajectoryBundleWriter, type TrajectoryReport } from '../trajectory/bundle-writer';

/** Arg keys that are always redacted */
const REDACT_KEYS = /password|token|secret|credential|api[_-]?key|authorization|auth[_-]token/i;

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
  /** Enable default-off episode trajectory bundle capture (#1059). */
  trajectoryBundle?: boolean;
  /** Test/internal override for the trajectory bundle root directory. */
  trajectoryRootDir?: string;
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
  /** Outcome Contract assertion results (≤ 4 KB total JSON; truncated if over) */
  contractResults?: ContractResultEntry[];
  /** Verbatim verify block from the tool response */
  verify?: Record<string, unknown>;
  /** Network requests correlated with this action (≤ 20 entries; truncated if over) */
  network?: NetworkEntry[];
  /** Console messages emitted during this action (≤ 20 entries; truncated if over) */
  console?: ConsoleEntry[];
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
  /**
   * Promise-chain mutex serializing every write to this recorder. Without this,
   * two concurrent recordAction() calls each read _seq before either has
   * incremented it, producing duplicate seq values (observed in concurrent
   * tests). appendContractResult() rides the same chain so contract rows can
   * never interleave with an in-flight recordAction().
   */
  private _writeChain: Promise<void> = Promise.resolve();
  private _trajectoryBundle: TrajectoryBundleWriter | null = null;
  private _lastTrajectoryReport: TrajectoryReport | null = null;

  constructor(store?: RecordingStore, configOverrides?: Partial<RecordingConfig>) {
    this.store = store ?? getRecordingStore();
    this.config = { ...DEFAULT_RECORDING_CONFIG, ...configOverrides };
  }

  /** Queue `op` behind any in-flight writes. Errors are isolated per-task. */
  private enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
    const next = this._writeChain.then(op, op);
    // Keep the chain alive even if op rejects, so later writes still serialize.
    this._writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Whether a recording is currently active */
  get isRecording(): boolean {
    return this._isRecording;
  }

  /** The active recording ID, or null if not recording */
  get activeRecordingId(): string | null {
    return this._activeRecordingId;
  }

  /** A snapshot of the active trajectory bundle, if enabled for the current recording. */
  get activeTrajectoryBundle(): { enabled: true; trajectory_id: string; dir: string } | null {
    return this._trajectoryBundle ? this._trajectoryBundle.snapshot : null;
  }

  /** The last finalized trajectory report, if the just-stopped recording had one. */
  get lastTrajectoryReport(): TrajectoryReport | null {
    return this._lastTrajectoryReport ? { ...this._lastTrajectoryReport } : null;
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

    this._trajectoryBundle = null;
    this._lastTrajectoryReport = null;
    if (opts?.trajectoryBundle === true) {
      try {
        this._trajectoryBundle = await TrajectoryBundleWriter.create({
          sessionId,
          recordingId: id,
          rootDir: opts.trajectoryRootDir,
        });
        metadata.trajectoryBundle = this._trajectoryBundle.snapshot;
        await this.store.writeMetadata(metadata);
      } catch (err) {
        console.error('[ActionRecorder] Trajectory bundle disabled:', err instanceof Error ? err.message : err);
        metadata.trajectoryBundle = { enabled: false };
      }
    }

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

    // Drain any in-flight writes BEFORE flipping `_isRecording = false`.
    // Otherwise recordAction()/appendContractResult() tasks still sitting on
    // the queue would see `_isRecording === false` when their turn comes and
    // silently no-op, losing recorded actions on a busy stop() (Codex P1).
    await this._writeChain;

    // After the chain has drained, take a final snapshot — actionCount may
    // have grown while we were waiting.
    const metadata: RecordingMetadata = {
      ...this._activeMetadata,
      stoppedAt: new Date().toISOString(),
    };

    if (this._trajectoryBundle) {
      const report = await this._trajectoryBundle.finalize();
      this._lastTrajectoryReport = report;
      metadata.trajectoryBundle = { ...this._trajectoryBundle.snapshot, report: report as unknown as Record<string, unknown> };
    }

    await this.store.writeMetadata(metadata);

    // Reset state
    this._isRecording = false;
    this._activeMetadata = null;
    this._activeRecordingId = null;
    this._trajectoryBundle = null;
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
    const sanitizedArgs = this.sanitizeArgs(args);

    // Serialize every write so concurrent callers can't share the same _seq.
    return this.enqueueWrite(async () => {
      if (!this._isRecording || this._activeRecordingId !== id || !this._activeMetadata) {
        return;
      }
      try {
        const seq = this._seq + 1;
        const action: RecordingAction = {
          seq,
          ts: Date.now(),
          tool,
          args: sanitizedArgs,
          durationMs,
          ok,
          summary: opts?.summary ?? `${ok ? '✓' : '✗'} ${tool}`,
          url: opts?.url,
          tabId: opts?.tabId ?? (args['tabId'] as string | undefined),
          error: opts?.error,
          ...applyContractResultsBounds(opts?.contractResults),
          ...applyVerifyField(opts?.verify),
          ...applyNetworkBounds(opts?.network),
          ...applyConsoleBounds(opts?.console),
        };

        await this.store.appendAction(id, action);
        if (this._trajectoryBundle) {
          await this._trajectoryBundle.appendToolCall({
            tool,
            args: sanitizedArgs,
            durationMs,
            ok,
            tabId: action.tabId,
            url: action.url,
            error: action.error,
            screenshotBefore: action.screenshotBefore,
            screenshotAfter: action.screenshotAfter,
          });
        }

        // Only advance seq and actionCount after successful write
        this._seq = seq;
        this._activeMetadata.actionCount = seq;
      } catch (err) {
        console.error('[ActionRecorder] Failed to record action:', err instanceof Error ? err.message : err);
      }
    });
  }

  /**
   * Append a contract result to the most recently recorded action.
   * No-op if not recording or no actions have been recorded yet.
   * This is the hook used by oc_assert.
   *
   * Uses an append-only sidecar row (`{kind:"contract_result",actionIndex,…}`)
   * rather than rewriting actions.jsonl in place. This removes the race window
   * where a concurrent recordAction() append could be clobbered by a contract
   * annotation that was based on an older snapshot.
   */
  async appendContractResult(entry: ContractResultEntry): Promise<void> {
    if (!this._isRecording || !this._activeRecordingId) {
      return;
    }
    const recordingIdAtCall = this._activeRecordingId;

    // Serialize so we read _seq AFTER any in-flight recordAction() completes —
    // otherwise the contract row could reference an action index that doesn't
    // exist yet on disk, or, worse, point at the wrong action when the in-flight
    // write resolves first.
    return this.enqueueWrite(async () => {
      if (!this._isRecording || this._activeRecordingId !== recordingIdAtCall || this._seq === 0) {
        return;
      }
      const id = this._activeRecordingId;
      const actionIndex = this._seq;
      try {
        await this.store.appendContractResultRow(id, actionIndex, entry);
        if (this._trajectoryBundle) {
          await this._trajectoryBundle.appendContract(entry);
        }
      } catch (err) {
        console.error('[ActionRecorder] Failed to append contract result:', err instanceof Error ? err.message : err);
      }
    });
  }


  /**
   * Append a checkpoint artifact to the active trajectory bundle.
   * No-op when recording or trajectory capture is disabled.
   */
  async appendCheckpoint(checkpoint: Record<string, unknown>): Promise<void> {
    if (!this._isRecording || !this._trajectoryBundle) return;
    return this.enqueueWrite(async () => {
      if (!this._isRecording || !this._trajectoryBundle) return;
      await this._trajectoryBundle.appendCheckpoint(checkpoint);
    });
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
      } else if (k === 'variables' && v !== null && typeof v === 'object') {
        sanitized[k] = Object.fromEntries(Object.keys(v as Record<string, unknown>).map((name) => [name, '[VARIABLE]']));
      } else if (Array.isArray(v)) {
        sanitized[k] = v.map((item) => item !== null && typeof item === 'object' ? this.sanitizeArgs(item as Record<string, unknown>) : item);
      } else if (v !== null && typeof v === 'object') {
        sanitized[k] = this.sanitizeArgs(v as Record<string, unknown>);
      } else {
        sanitized[k] = v;
      }
    }
    return sanitized;
  }
}

// ---------------------------------------------------------------------------
// Bounds helpers (module-private, exported only for tests via internal path)
// ---------------------------------------------------------------------------

const CONTRACT_RESULTS_MAX_BYTES = 4096;
const ARRAY_FIELD_MAX_ENTRIES = 20;

/**
 * Enforce the 4 KB cap on contractResults.
 * Returns a partial RecordingAction fragment (may be empty if undefined input).
 *
 * Size is measured in UTF-8 bytes (via Buffer.byteLength) — `json.length`
 * counts UTF-16 code units and would underestimate non-ASCII payloads.
 */
function applyContractResultsBounds(
  entries: ContractResultEntry[] | undefined,
): Pick<RecordingAction, 'contractResults'> {
  if (!entries || entries.length === 0) return {};
  const json = JSON.stringify(entries);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > CONTRACT_RESULTS_MAX_BYTES) {
    return {
      contractResults: [{ truncated: true, originalBytes: bytes } as unknown as ContractResultEntry],
    };
  }
  return { contractResults: entries };
}

/**
 * Pass through the verify field, omitting it when undefined.
 */
function applyVerifyField(
  verify: Record<string, unknown> | undefined,
): Pick<RecordingAction, 'verify'> {
  if (!verify) return {};
  return { verify };
}

/**
 * Enforce the 20-entry cap on network entries.
 */
function applyNetworkBounds(
  entries: NetworkEntry[] | undefined,
): Pick<RecordingAction, 'network'> {
  if (!entries || entries.length === 0) return {};
  if (entries.length > ARRAY_FIELD_MAX_ENTRIES) {
    const over = entries.length - ARRAY_FIELD_MAX_ENTRIES;
    return {
      network: [
        ...entries.slice(0, ARRAY_FIELD_MAX_ENTRIES),
        { method: '', url: `(+${over} more — truncated)` },
      ],
    };
  }
  return { network: entries };
}

/**
 * Enforce the 20-entry cap on console entries.
 */
function applyConsoleBounds(
  entries: ConsoleEntry[] | undefined,
): Pick<RecordingAction, 'console'> {
  if (!entries || entries.length === 0) return {};
  if (entries.length > ARRAY_FIELD_MAX_ENTRIES) {
    const over = entries.length - ARRAY_FIELD_MAX_ENTRIES;
    return {
      console: [
        ...entries.slice(0, ARRAY_FIELD_MAX_ENTRIES),
        { level: 'log' as const, text: `(+${over} more — truncated)`, ts: Date.now() },
      ],
    };
  }
  return { console: entries };
}

// ---------------------------------------------------------------------------
// Singleton registry: sessionId → ActionRecorder
// Per-session recorders allow oc_assert to look up the active recorder for
// a given MCP session without coupling to the global singleton.
// ---------------------------------------------------------------------------

/** Map of sessionId → ActionRecorder instances (populated on start()) */
const sessionRecorderRegistry = new Map<string, ActionRecorder>();

/** Singleton instance (global recorder used by the recording MCP tool) */
let instance: ActionRecorder | null = null;

export function getActionRecorder(): ActionRecorder {
  if (!instance) {
    instance = new ActionRecorder();
  }
  return instance;
}

/**
 * Register an ActionRecorder for a given sessionId so that oc_assert can
 * retrieve it. Called by the recording tool on start.
 */
export function registerSessionRecorder(sessionId: string, recorder: ActionRecorder): void {
  sessionRecorderRegistry.set(sessionId, recorder);
}

/**
 * Unregister an ActionRecorder for a given sessionId. Called on stop.
 */
export function unregisterSessionRecorder(sessionId: string): void {
  sessionRecorderRegistry.delete(sessionId);
}

/**
 * Get the active ActionRecorder for a given sessionId, if any recording is
 * in progress. Returns undefined if no recording is active for that session.
 * Used by oc_assert to append contract results to the most recent action.
 */
export function getActiveActionRecorder(sessionId: string): ActionRecorder | undefined {
  const recorder = sessionRecorderRegistry.get(sessionId);
  if (recorder && recorder.isRecording) {
    return recorder;
  }
  // Also check the global singleton in case it was started without explicit registration
  const global = getActionRecorder();
  if (global.isRecording && global.activeMetadata?.sessionId === sessionId) {
    return global;
  }
  return undefined;
}
