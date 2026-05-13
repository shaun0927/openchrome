/**
 * Automatic session snapshot policy.
 *
 * This module is intentionally side-effect free: workflow/task runners can use it
 * to decide when to call `oc_session_snapshot` without changing ordinary MCP tool
 * behavior. The policy is opt-in, bounded, and only constructs compact snapshot
 * memo arguments — it never captures raw page content, screenshots, cookies, or
 * credentials.
 */

export type SnapshotTrigger =
  | 'start'
  | 'retry'
  | 'reconnect'
  | 'final'
  | 'tool-count'
  | 'elapsed';

export interface AutoSnapshotPolicyConfig {
  /** Disabled by default; callers must opt in. */
  enabled?: boolean;
  /** Best-effort by default. Strict mode is for future workflow integrations. */
  mode?: 'best-effort' | 'strict';
  /** Create an interval snapshot every N tool calls. 0 disables count triggers. */
  everyToolCalls?: number;
  /** Create an interval snapshot every N milliseconds. 0 disables time triggers. */
  everyMs?: number;
  /** Retention hint for integrations; clamped to a safe positive range. */
  maxSnapshots?: number;
}

export interface NormalizedAutoSnapshotPolicy {
  enabled: boolean;
  mode: 'best-effort' | 'strict';
  everyToolCalls: number;
  everyMs: number;
  maxSnapshots: number;
}

export interface SnapshotPolicyState {
  /** Number of tool calls since the last recorded snapshot. */
  toolCallsSinceSnapshot?: number;
  /** Wall-clock ms when the last snapshot was recorded. */
  lastSnapshotAt?: number;
  /** Current wall-clock ms. Defaults to Date.now(). */
  now?: number;
}

export interface SnapshotDecision {
  shouldSnapshot: boolean;
  trigger: SnapshotTrigger | null;
  mode: 'best-effort' | 'strict';
  reason: string;
}

export interface SnapshotMemoInput {
  objective: string;
  currentStep: string;
  nextActions: string[];
  completedSteps?: string[];
  notes?: string;
  label?: string;
}

export interface SessionSnapshotArgs {
  objective: string;
  currentStep: string;
  nextActions: string[];
  completedSteps?: string[];
  notes?: string;
  label?: string;
}

const DEFAULT_MAX_SNAPSHOTS = 10;
const MAX_MAX_SNAPSHOTS = 100;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(authorization)\s*[:=]\s*bearer\s+([a-z0-9._~+/-]+=*)/gi,
  /\b(bearer)\s+([a-z0-9._~+/-]+=*)/gi,
  /\b(password|passwd|pwd)\s*[:=]\s*([^\s,;]+)/gi,
  /\b(api[_\s-]?key|token|secret|authorization)\s*[:=]\s*([^\s,;]+)/gi,
];

/**
 * Normalize external config into safe numeric bounds.
 */
export function normalizeAutoSnapshotPolicy(
  config: AutoSnapshotPolicyConfig | undefined,
): NormalizedAutoSnapshotPolicy {
  return {
    enabled: config?.enabled === true,
    mode: config?.mode === 'strict' ? 'strict' : 'best-effort',
    everyToolCalls: normalizeNonNegativeInt(config?.everyToolCalls),
    everyMs: normalizeNonNegativeInt(config?.everyMs),
    maxSnapshots: normalizeMaxSnapshots(config?.maxSnapshots),
  };
}

/**
 * Decide whether a caller should take a session snapshot for the current event.
 */
export function shouldTakeAutoSnapshot(
  config: AutoSnapshotPolicyConfig | undefined,
  event: SnapshotTrigger,
  state: SnapshotPolicyState = {},
): SnapshotDecision {
  const policy = normalizeAutoSnapshotPolicy(config);
  if (!policy.enabled) {
    return {
      shouldSnapshot: false,
      trigger: null,
      mode: policy.mode,
      reason: 'auto snapshot policy disabled',
    };
  }

  if (event === 'start' || event === 'retry' || event === 'reconnect' || event === 'final') {
    return {
      shouldSnapshot: true,
      trigger: event,
      mode: policy.mode,
      reason: `${event} snapshot trigger`,
    };
  }

  if (event === 'tool-count') {
    if (policy.everyToolCalls <= 0) {
      return noIntervalSnapshot(policy.mode, 'tool-count interval disabled');
    }
    const calls = state.toolCallsSinceSnapshot ?? 0;
    return calls >= policy.everyToolCalls
      ? {
          shouldSnapshot: true,
          trigger: 'tool-count',
          mode: policy.mode,
          reason: `tool-call interval reached (${calls}/${policy.everyToolCalls})`,
        }
      : noIntervalSnapshot(policy.mode, `tool-call interval not reached (${calls}/${policy.everyToolCalls})`);
  }

  if (event === 'elapsed') {
    if (policy.everyMs <= 0) {
      return noIntervalSnapshot(policy.mode, 'elapsed interval disabled');
    }
    const last = state.lastSnapshotAt;
    if (last === undefined) {
      return {
        shouldSnapshot: true,
        trigger: 'elapsed',
        mode: policy.mode,
        reason: 'no previous snapshot timestamp',
      };
    }
    const now = state.now ?? Date.now();
    const elapsed = now - last;
    return elapsed >= policy.everyMs
      ? {
          shouldSnapshot: true,
          trigger: 'elapsed',
          mode: policy.mode,
          reason: `elapsed interval reached (${elapsed}ms/${policy.everyMs}ms)`,
        }
      : noIntervalSnapshot(policy.mode, `elapsed interval not reached (${elapsed}ms/${policy.everyMs}ms)`);
  }

  return noIntervalSnapshot(policy.mode, 'unknown snapshot trigger');
}

/**
 * Construct sanitized args suitable for the existing `oc_session_snapshot` tool.
 */
export function buildAutoSnapshotArgs(
  input: SnapshotMemoInput,
  trigger: SnapshotTrigger,
): SessionSnapshotArgs {
  const args: SessionSnapshotArgs = {
    objective: redactSnapshotText(input.objective),
    currentStep: redactSnapshotText(input.currentStep),
    nextActions: input.nextActions.map(redactSnapshotText),
    label: input.label ? redactSnapshotText(input.label) : `auto-${trigger}`,
  };

  if (input.completedSteps !== undefined) {
    args.completedSteps = input.completedSteps.map(redactSnapshotText);
  }
  if (input.notes !== undefined) {
    args.notes = redactSnapshotText(input.notes);
  }

  return args;
}

/**
 * Return the next in-memory state after a snapshot attempt.
 * Call this only after the caller actually records (or attempts) a snapshot.
 */
export function markAutoSnapshotRecorded(
  state: SnapshotPolicyState = {},
  at: number = Date.now(),
): Required<Pick<SnapshotPolicyState, 'toolCallsSinceSnapshot' | 'lastSnapshotAt'>> {
  return {
    toolCallsSinceSnapshot: 0,
    lastSnapshotAt: at,
  };
}

/**
 * Compact redaction for snapshot memo fields. This is intentionally conservative
 * and dependency-free; deeper redaction remains the responsibility of callers
 * that have structured secrets.
 */
export function redactSnapshotText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, key: string) => `${key}=<redacted>`);
  }
  return redacted;
}

function noIntervalSnapshot(mode: 'best-effort' | 'strict', reason: string): SnapshotDecision {
  return {
    shouldSnapshot: false,
    trigger: null,
    mode,
    reason,
  };
}

function normalizeNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeMaxSnapshots(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_SNAPSHOTS;
  }
  const n = Math.floor(value);
  if (n <= 0) return DEFAULT_MAX_SNAPSHOTS;
  return Math.min(n, MAX_MAX_SNAPSHOTS);
}
