export const RUN_STATUSES = [
  'created',
  'running',
  'completed',
  'failed',
  'timed_out',
  'canceled',
  'aborted',
  'needs_user_input',
  'needs_strategy_change',
] as const;

export type RunStatus = typeof RUN_STATUSES[number];

export const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'completed',
  'failed',
  'timed_out',
  'canceled',
  'aborted',
  'needs_strategy_change',
]);

export type RunEventKind =
  | 'run_started'
  | 'run_finished'
  | 'tool_call_started'
  | 'tool_call_finished'
  | 'hint'
  | 'evidence'
  | 'failure';

export interface RunEvent {
  id: string;
  run_id: string;
  ts: number;
  kind: RunEventKind;
  session_id?: string;
  tab_id?: string;
  tool?: string;
  ok?: boolean;
  duration_ms?: number;
  args_hash?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface RunRecord {
  run_id: string;
  status: RunStatus;
  created_at: number;
  updated_at: number;
  session_id?: string;
  tab_id?: string;
  metadata?: Record<string, unknown>;
  events: RunEvent[];
}
