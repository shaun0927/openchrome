export type QueryDebugKind = 'extract' | 'element';

export interface QueryDebugRecord {
  kind: QueryDebugKind;
  sessionId: string;
  tabId: string;
  timestamp: string;
  normalized?: string;
  modeUsed?: string;
  schemaSummary?: { fields: string[]; multiple: boolean; queryRoot?: string };
  strategies?: string[];
  fieldsFound?: string[];
  fieldsMissing?: string[];
  durations?: Record<string, number>;
  output?: { chars: number; truncated: boolean };
  notes?: string[];
}

const MAX_RECORDS_PER_KEY = 5;
const MAX_TEXT_CHARS = 240;
const SECRET_PATTERNS = [
  /password\s*[:=]\s*[^\s,;]+/gi,
  /token\s*[:=]\s*[^\s,;]+/gi,
  /api[_-]?key\s*[:=]\s*[^\s,;]+/gi,
  /bearer\s+[a-z0-9._-]+/gi,
];

const records = new Map<string, QueryDebugRecord[]>();

function key(sessionId: string, tabId: string, kind: QueryDebugKind): string {
  return `${sessionId}::${tabId}::${kind}`;
}

export function sanitizeDebugText(value: string): string {
  let sanitized = value.slice(0, MAX_TEXT_CHARS);
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

function sanitizeRecord(record: QueryDebugRecord): QueryDebugRecord {
  return {
    ...record,
    normalized: record.normalized ? sanitizeDebugText(record.normalized) : undefined,
    notes: record.notes?.map(sanitizeDebugText).slice(0, 8),
    schemaSummary: record.schemaSummary
      ? { ...record.schemaSummary, fields: record.schemaSummary.fields.slice(0, 40).map(sanitizeDebugText) }
      : undefined,
    fieldsFound: record.fieldsFound?.slice(0, 40).map(sanitizeDebugText),
    fieldsMissing: record.fieldsMissing?.slice(0, 40).map(sanitizeDebugText),
    strategies: record.strategies?.slice(0, 12).map(sanitizeDebugText),
  };
}

export function recordQueryDebug(record: QueryDebugRecord): QueryDebugRecord {
  const safe = sanitizeRecord(record);
  const k = key(safe.sessionId, safe.tabId, safe.kind);
  const list = records.get(k) || [];
  list.unshift(safe);
  records.set(k, list.slice(0, MAX_RECORDS_PER_KEY));
  return safe;
}

export function getLatestQueryDebug(sessionId: string, tabId: string, kind: QueryDebugKind = 'extract'): QueryDebugRecord | null {
  return records.get(key(sessionId, tabId, kind))?.[0] || null;
}

export function clearQueryDebug(sessionId?: string, tabId?: string): void {
  if (!sessionId && !tabId) {
    records.clear();
    return;
  }
  for (const k of Array.from(records.keys())) {
    const [s, t] = k.split('::');
    if ((sessionId === undefined || s === sessionId) && (tabId === undefined || t === tabId)) {
      records.delete(k);
    }
  }
}
