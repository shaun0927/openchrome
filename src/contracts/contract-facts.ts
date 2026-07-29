import { wrapBoundaryMarker } from '../core/perception/boundary-markers';

export const CONTRACT_FACT_SCHEMA_VERSION = 1 as const;
export const MAX_CONTRACT_FACTS = 256;
export const MAX_CONTRACT_FACT_AGE_MS = 300_000;
export const MAX_CONSOLE_FACT_ENTRIES = 200;
export const MAX_CONSOLE_FACT_MESSAGE_CHARS = 1024;
export const MAX_CONSOLE_FACT_CAPTURE_TYPES = 64;

export type PerformanceUnit = 'ms' | 'seconds' | 'bytes' | 'count';
export type ConsoleFactMessageEncoding = 'plain' | 'oc_boundary_v1';

export type ContractFactErrorCode =
  | 'CONTRACT_FACTS_MISSING'
  | 'CONTRACT_FACT_SCHEMA_UNSUPPORTED'
  | 'CONTRACT_FACT_MALFORMED'
  | 'CONTRACT_FACT_SCOPE_MISSING'
  | 'CONTRACT_FACT_SCOPE_MISMATCH'
  | 'CONTRACT_FACT_STALE'
  | 'CONTRACT_FACT_NOT_FOUND'
  | 'CONTRACT_FACT_UNIT_MISMATCH'
  | 'CONTRACT_FACT_CAPTURE_FILTERED'
  | 'CONTRACT_FACT_TRUNCATED';

export interface ContractFactBase {
  schema_version: typeof CONTRACT_FACT_SCHEMA_VERSION;
  kind: 'performance' | 'console';
  source_tool: 'performance_metrics' | 'console_capture';
  session_id: string;
  target_id: string;
  captured_at: string;
}

export interface PerformanceContractFact extends ContractFactBase {
  kind: 'performance';
  source_tool: 'performance_metrics';
  metric: string;
  unit: PerformanceUnit;
  value: number;
}

export interface ConsoleContractFactEntry {
  type: string;
  message: string;
  count: number;
  uncaught: boolean;
}

export interface ConsoleContractFact extends ContractFactBase {
  kind: 'console';
  source_tool: 'console_capture';
  entries: ConsoleContractFactEntry[];
  captured_types: string[] | null;
  message_encoding: ConsoleFactMessageEncoding;
  truncated: boolean;
}

export type ContractFact = PerformanceContractFact | ConsoleContractFact;

export interface PerformanceFactMetrics {
  puppeteer?: Record<string, number>;
  navigation?: Record<string, number>;
  paint?: Record<string, number>;
  resource?: Array<{
    duration: number;
    size: number;
  }>;
  resource_summary?: {
    count: number;
    totalTransferSize: number;
    largestTransferSize: number;
    maxDuration: number;
  };
}

export interface ConsoleFactSourceEntry {
  type: string;
  text: string;
  count?: number;
  uncaught?: boolean;
  truncatedFrom?: number;
}

export interface ContractFactFailure {
  ok: false;
  code: ContractFactErrorCode;
  reason: string;
  details?: Record<string, unknown>;
}

export type ContractFactSelection<T extends ContractFact> =
  | { ok: true; fact: T }
  | ContractFactFailure;

interface FactSelectionScope {
  sessionId: string;
  targetId?: string;
  nowMs: number;
  maxAgeMs: number;
}

interface PerformanceSelectionScope extends FactSelectionScope {
  metric: string;
  unit: PerformanceUnit;
}

const PERFORMANCE_UNITS = new Set<PerformanceUnit>([
  'ms',
  'seconds',
  'bytes',
  'count',
]);
const CONSOLE_FACT_MESSAGE_ENCODINGS = new Set<ConsoleFactMessageEncoding>([
  'plain',
  'oc_boundary_v1',
]);

const PUPPETEER_METRIC_UNITS: Readonly<Record<string, PerformanceUnit>> = {
  Timestamp: 'seconds',
  Documents: 'count',
  Frames: 'count',
  JSEventListeners: 'count',
  Nodes: 'count',
  LayoutCount: 'count',
  RecalcStyleCount: 'count',
  LayoutDuration: 'seconds',
  RecalcStyleDuration: 'seconds',
  ScriptDuration: 'seconds',
  TaskDuration: 'seconds',
  JSHeapUsedSize: 'bytes',
  JSHeapTotalSize: 'bytes',
};

const METRIC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function buildPerformanceContractFacts(input: {
  sessionId: string;
  targetId: string;
  capturedAt: string;
  metrics: PerformanceFactMetrics;
}): PerformanceContractFact[] {
  const facts: PerformanceContractFact[] = [];
  const add = (metric: string, unit: PerformanceUnit, value: unknown): void => {
    if (!METRIC_NAME_RE.test(metric)) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    facts.push({
      schema_version: CONTRACT_FACT_SCHEMA_VERSION,
      kind: 'performance',
      source_tool: 'performance_metrics',
      session_id: input.sessionId,
      target_id: input.targetId,
      captured_at: input.capturedAt,
      metric,
      unit,
      value,
    });
  };

  for (const [name, value] of Object.entries(input.metrics.navigation ?? {})) {
    add(`navigation.${name}`, 'ms', value);
  }
  for (const [name, value] of Object.entries(input.metrics.paint ?? {})) {
    add(`paint.${name}`, 'ms', value);
  }
  for (const [name, value] of Object.entries(input.metrics.puppeteer ?? {})) {
    const unit = PUPPETEER_METRIC_UNITS[name];
    if (unit) add(`puppeteer.${name}`, unit, value);
  }

  const resourceSummary = input.metrics.resource_summary;
  if (
    resourceSummary
    && Number.isSafeInteger(resourceSummary.count)
    && resourceSummary.count >= 0
    && Number.isFinite(resourceSummary.totalTransferSize)
    && resourceSummary.totalTransferSize >= 0
    && Number.isFinite(resourceSummary.largestTransferSize)
    && resourceSummary.largestTransferSize >= 0
    && Number.isFinite(resourceSummary.maxDuration)
    && resourceSummary.maxDuration >= 0
  ) {
    add('resource.count', 'count', resourceSummary.count);
    add('resource.totalTransferSize', 'bytes', resourceSummary.totalTransferSize);
    add('resource.largestTransferSize', 'bytes', resourceSummary.largestTransferSize);
    add('resource.maxDuration', 'ms', resourceSummary.maxDuration);
  }

  return facts.sort((a, b) => a.metric.localeCompare(b.metric));
}

export function buildConsoleContractFact(input: {
  sessionId: string;
  targetId: string;
  capturedAt: string;
  entries: ConsoleFactSourceEntry[];
  capturedTypes?: string[] | null;
  messageEncoding?: ConsoleFactMessageEncoding;
  truncated?: boolean;
}): ConsoleContractFact {
  const captureScope = normalizeCapturedTypes(input.capturedTypes);
  const messageEncoding = input.messageEncoding ?? 'plain';
  let truncated = input.truncated === true
    || input.entries.length > MAX_CONSOLE_FACT_ENTRIES
    || captureScope.truncated;
  const selected = input.entries.length > MAX_CONSOLE_FACT_ENTRIES
    ? input.entries.slice(-MAX_CONSOLE_FACT_ENTRIES)
    : input.entries;
  const entries = selected.map((entry): ConsoleContractFactEntry => {
    const rawMessage = typeof entry.text === 'string' ? entry.text : String(entry.text ?? '');
    if (rawMessage.length > MAX_CONSOLE_FACT_MESSAGE_CHARS) truncated = true;
    const boundedMessage = rawMessage.slice(0, MAX_CONSOLE_FACT_MESSAGE_CHARS);
    if (entry.truncatedFrom !== undefined) truncated = true;
    const count = typeof entry.count === 'number'
      && Number.isInteger(entry.count)
      && entry.count > 0
      ? Math.min(entry.count, Number.MAX_SAFE_INTEGER)
      : 1;
    return {
      type: typeof entry.type === 'string' && entry.type.length > 0
        ? entry.type.slice(0, 64)
        : 'log',
      message: encodeConsoleContractFactMessage(boundedMessage, messageEncoding),
      count,
      uncaught: entry.uncaught === true,
    };
  });

  return {
    schema_version: CONTRACT_FACT_SCHEMA_VERSION,
    kind: 'console',
    source_tool: 'console_capture',
    session_id: input.sessionId,
    target_id: input.targetId,
    captured_at: input.capturedAt,
    entries,
    captured_types: captureScope.types,
    message_encoding: messageEncoding,
    truncated,
  };
}

export function isContractFact(value: unknown): value is ContractFact {
  if (!isRecord(value)) return false;
  if (value.kind === 'performance') return parsePerformanceFact(value).ok;
  if (value.kind === 'console') return parseConsoleFact(value).ok;
  return false;
}

export function decodeConsoleContractFactMessage(
  message: string,
  encoding: ConsoleFactMessageEncoding,
): string | undefined {
  if (encoding === 'plain') return message;
  const prefix = '<oc:console>';
  const suffix = '</oc:console>';
  if (!message.startsWith(prefix) || !message.endsWith(suffix)) return undefined;
  return message.slice(prefix.length, -suffix.length);
}

function encodeConsoleContractFactMessage(
  message: string,
  encoding: ConsoleFactMessageEncoding,
): string {
  return encoding === 'oc_boundary_v1'
    ? wrapBoundaryMarker('console', {}, message)
    : message;
}

export function selectPerformanceContractFact(
  input: unknown,
  scope: PerformanceSelectionScope,
): ContractFactSelection<PerformanceContractFact> {
  const arrayResult = readFactArray(input);
  if (!arrayResult.ok) return arrayResult;
  const candidates = arrayResult.facts.filter((fact) => (
    isRecord(fact) && fact.kind === 'performance' && fact.metric === scope.metric
  ));
  if (candidates.length === 0) {
    return failure(
      'CONTRACT_FACT_NOT_FOUND',
      `no performance contract fact found for metric ${scope.metric}`,
      { metric: scope.metric },
    );
  }

  const parsed = parseCandidates(candidates, parsePerformanceFact);
  if (parsed.facts.length === 0) return parsed.failure ?? malformedFailure();
  const unitMatches = parsed.facts.filter((fact) => fact.unit === scope.unit);
  if (unitMatches.length === 0) {
    return failure(
      'CONTRACT_FACT_UNIT_MISMATCH',
      `performance fact unit does not match ${scope.unit}`,
      { metric: scope.metric, expected_unit: scope.unit },
    );
  }
  return selectFreshest(unitMatches, scope);
}

export function selectConsoleContractFact(
  input: unknown,
  scope: FactSelectionScope,
): ContractFactSelection<ConsoleContractFact> {
  const arrayResult = readFactArray(input);
  if (!arrayResult.ok) return arrayResult;
  const candidates = arrayResult.facts.filter((fact) => (
    isRecord(fact) && fact.kind === 'console'
  ));
  if (candidates.length === 0) {
    return failure('CONTRACT_FACT_NOT_FOUND', 'no console contract fact found');
  }

  const parsed = parseCandidates(candidates, parseConsoleFact);
  if (parsed.facts.length === 0) return parsed.failure ?? malformedFailure();
  const selected = selectFreshest(parsed.facts, scope);
  if (!selected.ok) return selected;
  if (selected.fact.truncated) {
    return failure(
      'CONTRACT_FACT_TRUNCATED',
      'console contract fact is truncated and cannot prove the assertion',
      { captured_at: selected.fact.captured_at },
    );
  }
  return selected;
}

function readFactArray(input: unknown): { ok: true; facts: unknown[] } | ContractFactFailure {
  if (input === undefined || input === null) {
    return failure('CONTRACT_FACTS_MISSING', 'evidence.snapshot.contract_facts is missing');
  }
  if (!Array.isArray(input)) {
    return failure('CONTRACT_FACT_MALFORMED', 'contract_facts must be an array');
  }
  if (input.length === 0) {
    return failure('CONTRACT_FACTS_MISSING', 'contract_facts is empty');
  }
  if (input.length > MAX_CONTRACT_FACTS) {
    return failure(
      'CONTRACT_FACT_MALFORMED',
      `contract_facts exceeds the ${MAX_CONTRACT_FACTS}-fact limit`,
    );
  }
  return { ok: true, facts: input };
}

function parseCandidates<T extends ContractFact>(
  candidates: unknown[],
  parse: (value: unknown) => { ok: true; fact: T } | ContractFactFailure,
): { facts: T[]; failure?: ContractFactFailure } {
  const facts: T[] = [];
  let firstFailure: ContractFactFailure | undefined;
  for (const candidate of candidates) {
    const result = parse(candidate);
    if (result.ok) facts.push(result.fact);
    else if (!firstFailure || result.code === 'CONTRACT_FACT_SCHEMA_UNSUPPORTED') {
      firstFailure = result;
    }
  }
  return { facts, ...(firstFailure ? { failure: firstFailure } : {}) };
}

function parsePerformanceFact(
  value: unknown,
): { ok: true; fact: PerformanceContractFact } | ContractFactFailure {
  const base = parseBase(value, 'performance', 'performance_metrics');
  if (!base.ok) return base;
  const obj = value as Record<string, unknown>;
  if (typeof obj.metric !== 'string' || !METRIC_NAME_RE.test(obj.metric)) {
    return failure('CONTRACT_FACT_MALFORMED', 'performance fact metric is malformed');
  }
  if (typeof obj.unit !== 'string' || !PERFORMANCE_UNITS.has(obj.unit as PerformanceUnit)) {
    return failure('CONTRACT_FACT_MALFORMED', 'performance fact unit is malformed');
  }
  if (typeof obj.value !== 'number' || !Number.isFinite(obj.value)) {
    return failure('CONTRACT_FACT_MALFORMED', 'performance fact value must be finite');
  }
  return {
    ok: true,
    fact: {
      ...base.fact,
      kind: 'performance',
      source_tool: 'performance_metrics',
      metric: obj.metric,
      unit: obj.unit as PerformanceUnit,
      value: obj.value,
    },
  };
}

function parseConsoleFact(
  value: unknown,
): { ok: true; fact: ConsoleContractFact } | ContractFactFailure {
  const base = parseBase(value, 'console', 'console_capture');
  if (!base.ok) return base;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.entries) || obj.entries.length > MAX_CONSOLE_FACT_ENTRIES) {
    return failure('CONTRACT_FACT_MALFORMED', 'console fact entries are malformed');
  }
  if (typeof obj.truncated !== 'boolean') {
    return failure('CONTRACT_FACT_MALFORMED', 'console fact truncated flag is malformed');
  }
  let capturedTypes: string[] | null;
  if (obj.captured_types === null) {
    capturedTypes = null;
  } else if (
    Array.isArray(obj.captured_types)
    && obj.captured_types.length <= MAX_CONSOLE_FACT_CAPTURE_TYPES
  ) {
    capturedTypes = [];
    const seen = new Set<string>();
    for (const type of obj.captured_types) {
      if (!isBoundedString(type, 64) || seen.has(type)) {
        return malformedFailure('console fact captured_types is malformed');
      }
      seen.add(type);
      capturedTypes.push(type);
    }
  } else {
    return malformedFailure('console fact captured_types is malformed');
  }
  if (
    typeof obj.message_encoding !== 'string'
    || !CONSOLE_FACT_MESSAGE_ENCODINGS.has(obj.message_encoding as ConsoleFactMessageEncoding)
  ) {
    return malformedFailure('console fact message_encoding is malformed');
  }
  const messageEncoding = obj.message_encoding as ConsoleFactMessageEncoding;
  const entries: ConsoleContractFactEntry[] = [];
  let totalCount = 0;
  for (const entry of obj.entries) {
    if (!isRecord(entry)) return malformedFailure('console fact entry must be an object');
    if (typeof entry.type !== 'string' || entry.type.length === 0 || entry.type.length > 64) {
      return malformedFailure('console fact entry type is malformed');
    }
    if (typeof entry.message !== 'string') {
      return malformedFailure('console fact entry message is malformed');
    }
    const decodedMessage = decodeConsoleContractFactMessage(entry.message, messageEncoding);
    if (decodedMessage === undefined || decodedMessage.length > MAX_CONSOLE_FACT_MESSAGE_CHARS) {
      return malformedFailure('console fact entry message encoding is malformed');
    }
    if (
      typeof entry.count !== 'number'
      || !Number.isSafeInteger(entry.count)
      || entry.count <= 0
    ) {
      return malformedFailure('console fact entry count is malformed');
    }
    if (!Number.isSafeInteger(totalCount + entry.count)) {
      return malformedFailure('console fact total count exceeds the safe integer range');
    }
    totalCount += entry.count;
    if (typeof entry.uncaught !== 'boolean') {
      return malformedFailure('console fact entry uncaught flag is malformed');
    }
    entries.push({
      type: entry.type,
      message: entry.message,
      count: entry.count,
      uncaught: entry.uncaught,
    });
  }
  return {
    ok: true,
    fact: {
      ...base.fact,
      kind: 'console',
      source_tool: 'console_capture',
      entries,
      captured_types: capturedTypes,
      message_encoding: messageEncoding,
      truncated: obj.truncated,
    },
  };
}

function normalizeCapturedTypes(
  input: string[] | null | undefined,
): { types: string[] | null; truncated: boolean } {
  if (input === undefined || input === null) return { types: null, truncated: false };
  const types: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const value of input) {
    if (!isBoundedString(value, 64) || seen.has(value)) {
      truncated = true;
      continue;
    }
    seen.add(value);
    if (types.length >= MAX_CONSOLE_FACT_CAPTURE_TYPES) {
      truncated = true;
      continue;
    }
    types.push(value);
  }
  return { types, truncated };
}

function parseBase(
  value: unknown,
  kind: ContractFact['kind'],
  sourceTool: ContractFact['source_tool'],
): { ok: true; fact: ContractFactBase } | ContractFactFailure {
  if (!isRecord(value)) return malformedFailure('contract fact must be an object');
  if (value.schema_version !== CONTRACT_FACT_SCHEMA_VERSION) {
    return failure(
      'CONTRACT_FACT_SCHEMA_UNSUPPORTED',
      `unsupported contract fact schema version: ${String(value.schema_version)}`,
    );
  }
  if (value.kind !== kind || value.source_tool !== sourceTool) {
    return malformedFailure('contract fact kind/source_tool pair is malformed');
  }
  if (!isBoundedString(value.session_id, 256) || !isBoundedString(value.target_id, 256)) {
    return malformedFailure('contract fact session_id/target_id is malformed');
  }
  if (
    typeof value.captured_at !== 'string'
    || !Number.isFinite(Date.parse(value.captured_at))
  ) {
    return malformedFailure('contract fact captured_at is malformed');
  }
  return {
    ok: true,
    fact: {
      schema_version: CONTRACT_FACT_SCHEMA_VERSION,
      kind,
      source_tool: sourceTool,
      session_id: value.session_id,
      target_id: value.target_id,
      captured_at: new Date(value.captured_at).toISOString(),
    },
  };
}

function selectFreshest<T extends ContractFact>(
  facts: T[],
  scope: FactSelectionScope,
): ContractFactSelection<T> {
  if (!scope.targetId) {
    return failure(
      'CONTRACT_FACT_SCOPE_MISSING',
      'evidence.provenance.target_id is required for contract facts',
    );
  }
  const scoped = facts.filter((fact) => (
    fact.session_id === scope.sessionId && fact.target_id === scope.targetId
  ));
  if (scoped.length === 0) {
    return failure(
      'CONTRACT_FACT_SCOPE_MISMATCH',
      'contract facts do not belong to the current MCP session and target',
      { expected_session_id: scope.sessionId, expected_target_id: scope.targetId },
    );
  }
  const current = scoped.filter((fact) => Date.parse(fact.captured_at) <= scope.nowMs);
  if (current.length === 0) {
    const earliest = scoped.reduce((first, fact) => (
      Date.parse(fact.captured_at) < Date.parse(first.captured_at) ? fact : first
    ));
    return failure(
      'CONTRACT_FACT_MALFORMED',
      'matching contract facts are captured in the future',
      {
        captured_at: earliest.captured_at,
        future_by_ms: Date.parse(earliest.captured_at) - scope.nowMs,
      },
    );
  }
  const fresh = current.filter((fact) => (
    scope.nowMs - Date.parse(fact.captured_at) <= scope.maxAgeMs
  ));
  if (fresh.length === 0) {
    const newest = current.reduce((latest, fact) => (
      Date.parse(fact.captured_at) > Date.parse(latest.captured_at) ? fact : latest
    ));
    return failure(
      'CONTRACT_FACT_STALE',
      'matching contract facts are older than max_age_ms',
      {
        captured_at: newest.captured_at,
        age_ms: Math.max(0, scope.nowMs - Date.parse(newest.captured_at)),
        max_age_ms: scope.maxAgeMs,
      },
    );
  }
  const fact = fresh.reduce((latest, candidate) => (
    Date.parse(candidate.captured_at) > Date.parse(latest.captured_at)
      ? candidate
      : latest
  ));
  return { ok: true, fact };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function failure(
  code: ContractFactErrorCode,
  reason: string,
  details?: Record<string, unknown>,
): ContractFactFailure {
  return { ok: false, code, reason, ...(details ? { details } : {}) };
}

function malformedFailure(reason = 'contract fact is malformed'): ContractFactFailure {
  return failure('CONTRACT_FACT_MALFORMED', reason);
}
