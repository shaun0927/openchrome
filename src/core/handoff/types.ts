export type HandoffStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT';

export interface HandoffSnapshot {
  url?: string;
  title?: string;
  origin?: string;
  cookie_count?: number;
  local_storage_keys?: string[];
  session_storage_keys?: string[];
  dom_fingerprint?: string;
  screenshot_ref?: string;
}

export interface HandoffMeta {
  handoff_id: string;
  status: HandoffStatus;
  reason: string;
  run_id?: string;
  session_id?: string;
  tab_id?: string;
  resume_hint?: string;
  before?: HandoffSnapshot;
  after?: HandoffSnapshot;
  human_summary?: string;
  delta_summary?: string;
  task_run_evidence_appended?: boolean;
  task_run_evidence_error?: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  completed_at?: number;
}

export interface HandoffEvent {
  ts: number;
  kind: 'started' | 'finished' | 'cancelled' | 'timed_out' | 'status_checked';
  data?: Record<string, unknown>;
}

export interface StartHandoffInput {
  reason: string;
  run_id?: string;
  session_id?: string;
  tab_id?: string;
  resume_hint?: string;
  before?: HandoffSnapshot;
  ttl_ms?: number;
}

export interface FinishHandoffInput {
  after?: HandoffSnapshot;
  human_summary?: string;
}

export const TERMINAL_HANDOFF_STATUSES = new Set<HandoffStatus>(['COMPLETED', 'CANCELLED', 'TIMED_OUT']);
