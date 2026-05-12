import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomicSafe, readFileSafe } from '../../utils/atomic-file';
import { redactValue } from '../trace/redactor';
import { TaskRunStore } from '../task-run';
import {
  BulkProgressContract,
  BulkProgressFailedItem,
  BulkProgressScope,
  CompletionGuardResult,
  StartBulkProgressInput,
  UpdateBulkProgressInput,
} from './types';

const ID_BYTES = 8;
const MAX_ITEMS = 500;
const MAX_TEXT = 2048;
const MAX_STOP = 2048;

export interface BulkProgressStoreOptions {
  rootDir?: string;
  taskRunStore?: TaskRunStore;
  now?: () => number;
}

export class BulkProgressNotFoundError extends Error {
  code = 'bulk_progress_not_found';
}

export class BulkProgressInputError extends Error {
  code = 'invalid_bulk_progress_input';
}

export class BulkProgressStore {
  readonly rootDir: string;
  private readonly taskRunStore: TaskRunStore;
  private readonly now: () => number;

  constructor(opts: BulkProgressStoreOptions = {}) {
    const openchromeHome = process.env.OPENCHROME_HOME || path.join(os.homedir(), '.openchrome');
    this.rootDir = opts.rootDir || path.join(openchromeHome, 'progress-contracts');
    this.taskRunStore = opts.taskRunStore || new TaskRunStore();
    this.now = opts.now || (() => Date.now());
  }

  async start(input: StartBulkProgressInput): Promise<BulkProgressContract> {
    const ts = this.now();
    const stopCondition = optionalText(input.stop_condition, MAX_STOP);
    const itemKey = optionalText(input.item_key, MAX_TEXT);
    if (stopCondition === undefined) throw new BulkProgressInputError('stop_condition is required');
    if (itemKey === undefined) throw new BulkProgressInputError('item_key is required');

    const merged = mergeItems([], [], input.completed, input.failed);
    const contract: BulkProgressContract = pruneUndefined({
      contract_id: this.createId(`${input.run_id || ''}\0${stopCondition}\0${itemKey}`, ts),
      run_id: optionalText(input.run_id, MAX_TEXT),
      scope: normalizeScope(input.scope),
      expected_total: optionalNonNegativeInt(input.expected_total),
      min_completed: optionalNonNegativeInt(input.min_completed),
      stop_condition: stopCondition,
      stop_satisfied: input.stop_satisfied === true,
      item_key: itemKey,
      cursor: optionalText(input.cursor, MAX_TEXT),
      completed: merged.completed,
      failed: merged.failed,
      completed_truncated: merged.completedTruncated,
      failed_truncated: merged.failedTruncated,
      last_progress_at: ts,
      created_at: ts,
      updated_at: ts,
    });
    await this.write(contract);
    if (contract.run_id !== undefined) {
      await this.taskRunStore.update(contract.run_id, {
        bulk_contract_id: contract.contract_id,
        current_cursor: contract.cursor,
        completed_items: contract.completed,
        failed_items: contract.failed.map(item => ({ item: item.item, reason: item.reason })),
      });
    }
    return contract;
  }

  async get(contractId: string): Promise<BulkProgressContract> {
    const result = await readFileSafe<BulkProgressContract>(this.contractPath(contractId));
    if (result.success === false || result.data === undefined) {
      throw new BulkProgressNotFoundError(`Bulk progress contract ${contractId} not found`);
    }
    return result.data;
  }

  async update(contractId: string, input: UpdateBulkProgressInput): Promise<BulkProgressContract> {
    const current = await this.get(contractId);
    const ts = this.now();
    const merged = mergeItems(current.completed, current.failed, input.completed, input.failed);
    const contract: BulkProgressContract = pruneUndefined({
      ...current,
      expected_total: input.expected_total === undefined ? current.expected_total : optionalNonNegativeInt(input.expected_total),
      min_completed: input.min_completed === undefined ? current.min_completed : optionalNonNegativeInt(input.min_completed),
      stop_satisfied: input.stop_satisfied === undefined ? current.stop_satisfied : input.stop_satisfied === true,
      cursor: input.cursor === undefined ? current.cursor : optionalText(input.cursor, MAX_TEXT),
      completed: merged.completed,
      failed: merged.failed,
      completed_truncated: merged.completedTruncated || current.completed_truncated,
      failed_truncated: merged.failedTruncated || current.failed_truncated,
      last_progress_at: (input.completed || input.failed || input.cursor !== undefined || input.stop_satisfied !== undefined) ? ts : current.last_progress_at,
      updated_at: ts,
    });
    await this.write(contract);
    if (contract.run_id !== undefined) {
      await this.taskRunStore.update(contract.run_id, {
        current_cursor: contract.cursor,
        completed_items: contract.completed,
        failed_items: contract.failed.map(item => ({ item: item.item, reason: item.reason })),
      });
    }
    return contract;
  }

  checkCompletionGuard(contract: BulkProgressContract): CompletionGuardResult {
    const completedCount = contract.completed.length;
    const failedCount = contract.failed.length;
    if (contract.expected_total !== undefined) {
      const observed = completedCount + failedCount;
      if (observed < contract.expected_total) {
        return {
          allowed: false,
          reason: `Bulk progress incomplete: ${observed}/${contract.expected_total} ${contract.item_key} items observed.`,
          missing_count: contract.expected_total - observed,
          failed_count: failedCount,
          completed_count: completedCount,
          expected_total: contract.expected_total,
          min_completed: contract.min_completed,
          stop_satisfied: contract.stop_satisfied,
          suggested_next_action: `Continue processing ${contract.item_key} items from cursor ${contract.cursor || '(none)'}.`,
        };
      }
    }
    if (contract.min_completed !== undefined && completedCount < contract.min_completed) {
      return {
        allowed: false,
        reason: `Bulk progress incomplete: min_completed ${contract.min_completed} not met.`,
        missing_count: contract.min_completed - completedCount,
        failed_count: failedCount,
        completed_count: completedCount,
        expected_total: contract.expected_total,
        min_completed: contract.min_completed,
        stop_satisfied: contract.stop_satisfied,
        suggested_next_action: `Complete at least ${contract.min_completed - completedCount} more ${contract.item_key} item(s), or use force with a reason if the task must end early.`,
      };
    }
    if (contract.expected_total === undefined && contract.stop_satisfied === false) {
      return {
        allowed: false,
        reason: `Bulk progress incomplete: stop condition is not satisfied (${contract.stop_condition}).`,
        failed_count: failedCount,
        completed_count: completedCount,
        min_completed: contract.min_completed,
        stop_satisfied: false,
        suggested_next_action: `Continue until stop condition is satisfied: ${contract.stop_condition}.`,
      };
    }
    return {
      allowed: true,
      failed_count: failedCount,
      completed_count: completedCount,
      expected_total: contract.expected_total,
      min_completed: contract.min_completed,
      stop_satisfied: contract.stop_satisfied,
    };
  }

  async check(contractId: string): Promise<CompletionGuardResult> {
    return this.checkCompletionGuard(await this.get(contractId));
  }

  private createId(seed: string, ts: number): string {
    return crypto.createHash('sha256')
      .update(seed)
      .update('\0')
      .update(String(ts))
      .update('\0')
      .update(crypto.randomBytes(ID_BYTES))
      .digest('hex')
      .slice(0, 16);
  }

  private async write(contract: BulkProgressContract): Promise<void> {
    await writeFileAtomicSafe(this.contractPath(contract.contract_id), contract);
  }

  private contractPath(contractId: string): string {
    assertSafeId(contractId);
    return path.join(this.rootDir, `${contractId}.json`);
  }
}

function mergeItems(
  currentCompleted: string[],
  currentFailed: BulkProgressFailedItem[],
  completedInput?: string[],
  failedInput?: BulkProgressFailedItem[],
): { completed: string[]; failed: BulkProgressFailedItem[]; completedTruncated: number; failedTruncated: number } {
  const completed = Array.from(new Set([...currentCompleted, ...sanitizeCompleted(completedInput)]));
  const failedByItem = new Map<string, BulkProgressFailedItem>();
  for (const item of [...currentFailed, ...sanitizeFailed(failedInput)]) {
    failedByItem.set(item.item, item);
  }
  const failed = Array.from(failedByItem.values());
  return {
    completed: completed.slice(-MAX_ITEMS),
    failed: failed.slice(-MAX_ITEMS),
    completedTruncated: Math.max(0, completed.length - MAX_ITEMS),
    failedTruncated: Math.max(0, failed.length - MAX_ITEMS),
  };
}

function sanitizeCompleted(values: unknown): string[] {
  if (Array.isArray(values) === false) return [];
  return values.map(item => optionalText(item, MAX_TEXT)).filter((item): item is string => item !== undefined);
}

function sanitizeFailed(values: unknown): BulkProgressFailedItem[] {
  if (Array.isArray(values) === false) return [];
  return values
    .filter((item): item is BulkProgressFailedItem => Boolean(item) && typeof item === 'object' && typeof (item as BulkProgressFailedItem).item === 'string')
    .map(item => pruneUndefined({
      item: optionalText(item.item, MAX_TEXT) || '',
      reason: optionalText(item.reason, MAX_TEXT) || '',
      retryable: typeof item.retryable === 'boolean' ? item.retryable : undefined,
    }))
    .filter(item => item.item.length > 0);
}

function normalizeScope(scope: unknown): BulkProgressScope {
  return scope === 'workflow' || scope === 'batch' || scope === 'crawl' ? scope : 'task_run';
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const redacted = String(redactValue(trimmed));
  return redacted.length > max ? redacted.slice(0, max) : redacted;
}

function optionalNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isFinite(value) === false) return undefined;
  return Math.max(0, Math.floor(value));
}

function assertSafeId(id: string): void {
  if (/^[a-f0-9]{16}$/i.test(id) === false) {
    throw new Error(`Invalid bulk progress contract id: ${id}`);
  }
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}
