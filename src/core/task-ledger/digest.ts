import * as crypto from 'node:crypto';

import type { TaskEvent, TaskMeta } from './types';
import type { TaskStore } from './store';

export type TaskEvidenceCategory = 'navigation' | 'observation' | 'interaction' | 'assertion' | 'recovery' | 'checkpoint';

export interface TaskEvidenceDigestEvent {
  ts: number;
  tool: string;
  ok: boolean;
  category: TaskEvidenceCategory;
  summary: string;
  evidence_ref?: string;
}

export interface TaskEvidenceDigest {
  task_id: string;
  updated_at: number;
  objective: string;
  phase: string;
  page_state: {
    url?: string;
    title?: string;
    tabId?: string;
    capturedAt?: number;
  };
  recent_meaningful_events: TaskEvidenceDigestEvent[];
  latest_assertions?: Array<{ contract_id?: string; passed: boolean; summary: string }>;
  latest_failures?: Array<{ tool: string; normalized_error: string; suggested_recovery?: string }>;
  budget_status?: string;
}

export interface BuildTaskEvidenceDigestOptions {
  maxEvents?: number;
  maxSummaryChars?: number;
}

const DEFAULT_MAX_EVENTS = 20;
const DEFAULT_MAX_SUMMARY_CHARS = 240;
const SECRET_KEY_RE = /(password|passwd|secret|token|api[_-]?key|authorization|cookie)/i;

export function buildTaskEvidenceDigest(
  store: TaskStore,
  taskId: string,
  options: BuildTaskEvidenceDigestOptions = {},
): TaskEvidenceDigest | undefined {
  const meta = store.readMetaSync(taskId);
  if (!meta) return undefined;
  const events = store.readEventsSync(taskId);
  const result = store.readResultSync(taskId);
  return digestFromParts(meta, events, result, options);
}

export function digestFromParts(
  meta: TaskMeta,
  events: TaskEvent[],
  result: unknown,
  options: BuildTaskEvidenceDigestOptions = {},
): TaskEvidenceDigest {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const pageState = pageStateFrom(meta, result);
  const meaningfulEvents = events
    .map((event, index) => eventToDigestEvent(meta, event, index, maxSummaryChars))
    .filter((event): event is TaskEvidenceDigestEvent => event !== null)
    .slice(-maxEvents);

  const latestAssertions = assertionsFrom(result, maxSummaryChars);
  const latestFailures = failuresFrom(meta, events, result, maxSummaryChars);
  const budgetStatus = budgetStatusFrom(result, maxSummaryChars);

  return {
    task_id: meta.task_id,
    updated_at: meta.ended_at ?? lastEventTs(events) ?? meta.started_at ?? meta.created_at,
    objective: objectiveFrom(meta),
    phase: phaseFrom(meta),
    page_state: pageState,
    recent_meaningful_events: meaningfulEvents,
    ...(latestAssertions.length > 0 ? { latest_assertions: latestAssertions } : {}),
    ...(latestFailures.length > 0 ? { latest_failures: latestFailures } : {}),
    ...(budgetStatus ? { budget_status: budgetStatus } : {}),
  };
}

function eventToDigestEvent(meta: TaskMeta, event: TaskEvent, index: number, maxSummaryChars: number): TaskEvidenceDigestEvent | null {
  const data = recordFrom(event.data);
  const tool = stringField(data.tool) ?? stringField(data.toolName) ?? meta.kind;
  const ok = event.kind !== 'failed' && event.kind !== 'cancelled' && !booleanField(data.isError);
  const category = categoryFor(tool, event, data);
  const rawSummary = stringField(data.summary)
    ?? stringField(data.message)
    ?? stringField(data.error)
    ?? defaultSummary(event, tool, ok);
  return {
    ts: event.ts,
    tool,
    ok,
    category,
    summary: clamp(redact(rawSummary), maxSummaryChars),
    evidence_ref: evidenceRef(meta.task_id, index, event),
  };
}

function defaultSummary(event: TaskEvent, tool: string, ok: boolean): string {
  if (event.kind === 'started') return `Started ${tool}`;
  if (event.kind === 'completed') return `Completed ${tool}`;
  if (event.kind === 'failed') return `${tool} failed`;
  if (event.kind === 'cancelled') return `${tool} cancelled`;
  if (event.kind === 'cancel_requested') return `${tool} cancellation requested`;
  return `${tool} ${ok ? 'event' : 'error'}`;
}

function categoryFor(tool: string, event: TaskEvent, data: Record<string, unknown>): TaskEvidenceCategory {
  const explicit = stringField(data.category);
  if (explicit && ['navigation', 'observation', 'interaction', 'assertion', 'recovery', 'checkpoint'].includes(explicit)) {
    return explicit as TaskEvidenceCategory;
  }
  if (/navigate|goto|crawl|sitemap/i.test(tool)) return 'navigation';
  if (/read|snapshot|extract|observe|find|context|console|network/i.test(tool)) return 'observation';
  if (/assert|verify/i.test(tool)) return 'assertion';
  if (/recover|hint|ralph|handoff/i.test(tool)) return 'recovery';
  if (/interact|click|fill|type|input|act|computer/i.test(tool)) return 'interaction';
  if (event.kind === 'progress') return 'checkpoint';
  return 'checkpoint';
}

function pageStateFrom(meta: TaskMeta, result: unknown): TaskEvidenceDigest['page_state'] {
  const args = recordFrom(meta.args_summary);
  const data = recordFrom(result);
  const structured = recordFrom(data.structuredContent);
  const page = firstNonEmptyRecord(data.page_state, data.pageState, structured);
  const capturedAt = numberField(page.capturedAt) ?? numberField(page.captured_at) ?? meta.ended_at ?? meta.started_at;
  const tabId = stringField(data.tabId)
    ?? stringField(data.tab_id)
    ?? stringField(page.tabId)
    ?? stringField(page.tab_id)
    ?? stringField(args.tabId);
  return {
    ...(stringField(data.url) ?? stringField(page.url) ?? stringField(args.url) ? { url: stringField(data.url) ?? stringField(page.url) ?? stringField(args.url) } : {}),
    ...(stringField(data.title) ?? stringField(page.title) ? { title: stringField(data.title) ?? stringField(page.title) } : {}),
    ...(tabId ? { tabId } : {}),
    ...(capturedAt ? { capturedAt } : {}),
  };
}

function assertionsFrom(
  result: unknown,
  maxSummaryChars: number,
): NonNullable<TaskEvidenceDigest['latest_assertions']> {
  const data = recordFrom(result);
  const candidates = arrayField(data.assertions) ?? arrayField(data.latest_assertions) ?? arrayField(recordFrom(data.structuredContent).assertions);
  if (!candidates) return [];
  return candidates.slice(-10).map((item) => {
    const row = recordFrom(item);
    const summary = stringField(row.summary) ?? stringField(row.message) ?? JSON.stringify(redactValue(row));
    return {
      ...(stringField(row.contract_id) ?? stringField(row.contractId) ? { contract_id: stringField(row.contract_id) ?? stringField(row.contractId) } : {}),
      passed: booleanField(row.passed) ?? booleanField(row.ok) ?? false,
      summary: clamp(redact(summary), maxSummaryChars),
    };
  });
}

function failuresFrom(
  meta: TaskMeta,
  events: TaskEvent[],
  result: unknown,
  maxSummaryChars: number,
): NonNullable<TaskEvidenceDigest['latest_failures']> {
  const failures: NonNullable<TaskEvidenceDigest['latest_failures']> = [];
  if (meta.error?.message) {
    failures.push({ tool: meta.kind, normalized_error: clamp(redact(meta.error.message), maxSummaryChars), suggested_recovery: recoveryFor(meta.error.message) });
  }
  for (const event of events.slice(-20)) {
    const data = recordFrom(event.data);
    const message = stringField(data.error) ?? stringField(recordFrom(data.error).message);
    if (event.kind === 'failed' && message) {
      const tool = stringField(data.tool) ?? stringField(data.toolName) ?? meta.kind;
      failures.push({ tool, normalized_error: clamp(redact(message), maxSummaryChars), suggested_recovery: recoveryFor(message) });
    }
  }
  const data = recordFrom(result);
  if (booleanField(data.isError) === true) {
    const text = extractContentText(result) ?? stringField(data.error) ?? 'MCP result marked isError';
    failures.push({ tool: meta.kind, normalized_error: clamp(redact(text), maxSummaryChars), suggested_recovery: recoveryFor(text) });
  }
  return failures.slice(-10);
}

function budgetStatusFrom(result: unknown, maxSummaryChars: number): string | undefined {
  const data = recordFrom(result);
  const raw = stringField(data.budget_status) ?? stringField(data.budgetStatus) ?? stringField(recordFrom(data.structuredContent).budget_status);
  return raw ? clamp(redact(raw), maxSummaryChars) : undefined;
}

function objectiveFrom(meta: TaskMeta): string {
  const args = recordFrom(meta.args_summary);
  return clamp(redact(stringField(args.objective) ?? stringField(args.task) ?? stringField(args.query) ?? `${meta.kind} task`), 240);
}

function phaseFrom(meta: TaskMeta): string {
  if (meta.status === 'PENDING') return 'pending';
  if (meta.status === 'RUNNING') return 'running';
  if (meta.status === 'COMPLETED') return 'completed';
  if (meta.status === 'CANCELLED') return 'cancelled';
  return 'failed';
}

function evidenceRef(taskId: string, index: number, event: TaskEvent): string {
  const hash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 12);
  return `task://${taskId}/events/${index}#${hash}`;
}

function recoveryFor(text: string): string | undefined {
  if (/stale|no longer available/i.test(text)) return 'Refresh page state and reacquire element refs before retrying.';
  if (/timeout|timed out/i.test(text)) return 'Check progress and narrow the wait condition or task budget.';
  if (/not found|no match/i.test(text)) return 'Inspect current page state and try a broader selector or semantic query.';
  if (/auth|login|captcha|forbidden|access denied/i.test(text)) return 'Request user assistance or a valid authenticated session.';
  return undefined;
}

function lastEventTs(events: TaskEvent[]): number | undefined {
  return events.length > 0 ? events[events.length - 1].ts : undefined;
}

function extractContentText(value: unknown): string | undefined {
  const data = recordFrom(value);
  const content = arrayField(data.content);
  if (!content) return undefined;
  const text = content
    .map(item => stringField(recordFrom(item).text))
    .filter((item): item is string => Boolean(item))
    .join('\n');
  return text || undefined;
}

function clamp(value: string, max: number): string {
  const text = normalise(value);
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/(password|passwd|secret|token|api[_-]?key|authorization|cookie)(["'\s:=]+)([^\s,"'}]+)/gi, '$1$2[redacted]');
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : redactValue(child);
    }
    return out;
  }
  if (typeof value === 'string') return redact(value);
  return value;
}


function firstNonEmptyRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const record = recordFrom(value);
    if (Object.keys(record).length > 0) return record;
  }
  return {};
}

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayField(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
