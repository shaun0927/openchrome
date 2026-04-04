/**
 * Type definitions for the Session Recording & Replay subsystem.
 * Part of #572: Session Recording & Replay.
 */

/**
 * A single recorded action within a session recording.
 */
export interface RecordingAction {
  /** Monotonically increasing sequence number within the recording */
  seq: number;
  /** Unix timestamp in milliseconds */
  ts: number;
  /** MCP tool name (e.g., "navigate", "interact") */
  tool: string;
  /** Sanitized tool arguments */
  args: Record<string, unknown>;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Whether the tool call succeeded */
  ok: boolean;
  /** Human-readable 1-line summary */
  summary: string;
  /** URL at time of action, if available */
  url?: string;
  /** Target tab identifier, if applicable */
  tabId?: string;
  /** Error message if ok=false */
  error?: string;
  /** Filename of screenshot taken before the action */
  screenshotBefore?: string;
  /** Filename of screenshot taken after the action */
  screenshotAfter?: string;
}

/**
 * Metadata for a single recording session.
 */
export interface RecordingMetadata {
  /** Schema version, always 1 for this version */
  version: 1;
  /** Unique recording identifier (e.g., "rec-20240101-120000-abcd") */
  id: string;
  /** MCP session identifier from the server */
  sessionId: string;
  /** ISO 8601 timestamp when recording started */
  startedAt: string;
  /** ISO 8601 timestamp when recording stopped */
  stoppedAt?: string;
  /** Total number of actions recorded */
  actionCount: number;
  /** Browser profile name, if applicable */
  profile?: string;
  /** Optional user-supplied label for the recording */
  label?: string;
}

/**
 * Configuration for the recording subsystem.
 */
export interface RecordingConfig {
  /** Whether to capture screenshots before/after each action */
  captureScreenshots: boolean;
  /** Image format for screenshots */
  screenshotFormat: 'webp' | 'jpeg' | 'png';
  /** Screenshot quality (1-100, used for webp/jpeg) */
  screenshotQuality: number;
  /** Number of days to retain recordings before automatic cleanup */
  retentionDays: number;
  /** Maximum number of recordings to keep (oldest deleted first) */
  maxRecordings: number;
}

/**
 * Default configuration values for the recording subsystem.
 */
export const DEFAULT_RECORDING_CONFIG: RecordingConfig = {
  captureScreenshots: true,
  screenshotFormat: 'webp',
  screenshotQuality: 60,
  retentionDays: 7,
  maxRecordings: 50,
};
