/**
 * Type definitions for the Session Recording & Replay subsystem.
 * Part of #572: Session Recording & Replay.
 */

/**
 * A single Outcome Contract assertion result attached to a recorded action.
 */
export interface ContractResultEntry {
  /** Verbatim Assertion JSON from the DSL */
  assertion: unknown;
  /** Evaluation verdict */
  verdict: 'pass' | 'fail' | 'inconclusive';
  /** Implementation-defined evidence details */
  details?: Record<string, unknown>;
}

/**
 * A single network request entry attached to a recorded action.
 */
export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
}

/**
 * A single console message entry attached to a recorded action.
 */
export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error';
  text: string;
  /** Unix timestamp in milliseconds */
  ts: number;
}

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
  /** Outcome Contract assertion results for this action (≤ 4 KB total JSON) */
  contractResults?: ContractResultEntry[];
  /** Verbatim verify block from the tool response, if present */
  verify?: Record<string, unknown>;
  /** Network requests correlated with this action (≤ 20 entries) */
  network?: NetworkEntry[];
  /** Console messages emitted during this action (≤ 20 entries) */
  console?: ConsoleEntry[];
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
  /** Optional active trajectory bundle metadata (#1059). */
  trajectoryBundle?: { enabled: boolean; trajectory_id?: string; dir?: string; report?: Record<string, unknown> };
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
  captureScreenshots: false,
  screenshotFormat: 'webp',
  screenshotQuality: 60,
  retentionDays: 7,
  maxRecordings: 50,
};
