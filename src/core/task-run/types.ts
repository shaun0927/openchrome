export type TaskRunStatus = 'PENDING' | 'RUNNING' | 'NEEDS_HELP' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type EvidenceKind = 'journal' | 'screenshot' | 'contract' | 'ledger_task' | 'workflow' | 'url' | 'handoff';

export interface EvidencePointer {
  kind: EvidenceKind;
  ref: string;
  summary?: string;
}

export interface FailedItem {
  item: string;
  reason: string;
}

export interface NeedsHelpState {
  reason: string;
  requested_at: number;
  resume_hint?: string;
}

export interface TaskRunMeta {
  run_id: string;
  status: TaskRunStatus;
  goal: string;
  success_criteria?: string[];
  session_id?: string;
  workflow_id?: string;
  ledger_task_ids: string[];
  progress_summary?: string;
  completed_items?: string[];
  failed_items?: FailedItem[];
  completed_items_truncated?: number;
  failed_items_truncated?: number;
  current_cursor?: string;
  last_evidence?: EvidencePointer[];
  needs_help?: NeedsHelpState;
  created_at: number;
  updated_at: number;
  completed_at?: number;
}

export interface TaskRunEvent {
  seq?: number;
  ts: number;
  kind: 'started' | 'updated' | 'checkpointed' | 'needs_help' | 'completed' | 'failed' | 'cancelled';
  data?: Record<string, unknown>;
}

export interface TaskRunCheckpoint {
  checkpoint_id: string;
  run_id: string;
  source_event_range: { from: number; to: number };
  summary: string;
  current_cursor?: string;
  completed_count?: number;
  failed_count?: number;
  last_url?: string;
  event_count?: number;
  redaction_applied?: boolean;
  evidence?: EvidencePointer[];
  created_at: number;
}

export interface TaskRunListFilter {
  status?: TaskRunStatus;
  limit?: number;
  since?: number;
}

export const TERMINAL_TASK_RUN_STATUSES = new Set<TaskRunStatus>(['COMPLETED', 'FAILED', 'CANCELLED']);
