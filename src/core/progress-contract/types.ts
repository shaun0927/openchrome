export type BulkProgressScope = 'task_run' | 'workflow' | 'batch' | 'crawl';

export interface BulkProgressFailedItem {
  item: string;
  reason: string;
  retryable?: boolean;
}

export interface BulkProgressContract {
  contract_id: string;
  run_id?: string;
  scope: BulkProgressScope;
  expected_total?: number;
  min_completed?: number;
  stop_condition: string;
  stop_satisfied: boolean;
  item_key: string;
  cursor?: string;
  completed: string[];
  failed: BulkProgressFailedItem[];
  completed_truncated?: number;
  failed_truncated?: number;
  last_progress_at: number;
  created_at: number;
  updated_at: number;
}

export interface CompletionGuardResult {
  allowed: boolean;
  reason?: string;
  missing_count?: number;
  failed_count?: number;
  completed_count: number;
  expected_total?: number;
  min_completed?: number;
  stop_satisfied?: boolean;
  suggested_next_action?: string;
}

export interface StartBulkProgressInput {
  run_id?: string;
  scope?: BulkProgressScope;
  expected_total?: number;
  min_completed?: number;
  stop_condition: string;
  stop_satisfied?: boolean;
  item_key: string;
  cursor?: string;
  completed?: string[];
  failed?: BulkProgressFailedItem[];
}

export interface UpdateBulkProgressInput {
  cursor?: string;
  completed?: string[];
  failed?: BulkProgressFailedItem[];
  stop_satisfied?: boolean;
  expected_total?: number;
  min_completed?: number;
}
