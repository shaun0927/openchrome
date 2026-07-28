export type TargetCreationState = 'provisional' | 'ready' | 'blocked' | 'closed';

export interface TargetCreationRegistration {
  targetId: string;
  sessionId: string;
  workerId: string;
  openerTargetId: string;
  state: Exclude<TargetCreationState, 'closed'>;
  url?: string;
  title?: string;
  createdAt?: number;
  ownershipCommitted?: boolean;
}

export interface TargetCreationRecord {
  sequence: number;
  targetId: string;
  sessionId: string;
  workerId: string;
  openerTargetId: string;
  currentOpenerTargetId: string;
  state: TargetCreationState;
  url: string;
  title: string;
  createdAt: number;
  ownershipCommittedAt?: number;
  readyAt?: number;
  blockedAt?: number;
  closedAt?: number;
}

export interface OpenedTabFact {
  tabId: string;
  workerId: string;
  url: string;
  title: string;
  status: 'ready' | 'closed';
}

export interface TargetCreationQuery {
  afterSequence: number;
  sessionId: string;
  workerId: string;
  openerTargetId: string;
  limit?: number;
}

export interface TargetCreationQueryResult {
  total: number;
  truncated: boolean;
  pendingCount: number;
  tabs: OpenedTabFact[];
}

const DEFAULT_MAX_RECORDS = 2048;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 200;
const MAX_ID_LENGTH = 128;

function sanitizeText(value: string | undefined, maxLength: number): string {
  if (!value) return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function sanitizeTargetUrl(value: string | undefined): string {
  const cleaned = sanitizeText(value, MAX_URL_LENGTH * 2);
  if (!cleaned) return '';
  try {
    const parsed = new URL(cleaned);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString().slice(0, MAX_URL_LENGTH);
  } catch {
    return cleaned.split('#', 1)[0].slice(0, MAX_URL_LENGTH);
  }
}

export function sanitizeTargetTitle(value: string | undefined): string {
  return sanitizeText(value, MAX_TITLE_LENGTH);
}

export class TargetCreationLedger {
  private readonly records = new Map<number, TargetCreationRecord>();
  private readonly targetToSequence = new Map<string, number>();
  private sequence = 0;

  constructor(private readonly maxRecords = DEFAULT_MAX_RECORDS) {
    if (!Number.isInteger(maxRecords) || maxRecords < 1) {
      throw new Error('TargetCreationLedger maxRecords must be a positive integer');
    }
  }

  getCursor(): number {
    return this.sequence;
  }

  get size(): number {
    return this.records.size;
  }

  has(targetId: string): boolean {
    return this.targetToSequence.has(targetId);
  }

  get(targetId: string): TargetCreationRecord | undefined {
    const sequence = this.targetToSequence.get(targetId);
    const record = sequence === undefined ? undefined : this.records.get(sequence);
    return record ? { ...record } : undefined;
  }

  register(input: TargetCreationRegistration): TargetCreationRecord {
    const existing = this.get(input.targetId);
    if (existing) {
      if (input.state === 'ready') {
        this.markReady(input.targetId, { url: input.url, title: input.title }, input.createdAt);
      } else if (input.state === 'blocked') {
        this.markBlocked(input.targetId, input.createdAt);
      }
      return this.get(input.targetId)!;
    }

    const createdAt = input.createdAt ?? Date.now();
    const sequence = ++this.sequence;
    const record: TargetCreationRecord = {
      sequence,
      targetId: input.targetId,
      sessionId: input.sessionId,
      workerId: input.workerId,
      openerTargetId: input.openerTargetId,
      currentOpenerTargetId: input.openerTargetId,
      state: input.state,
      url: input.state === 'ready' ? sanitizeTargetUrl(input.url) : '',
      title: input.state === 'ready' ? sanitizeTargetTitle(input.title) : '',
      createdAt,
      ...(input.ownershipCommitted !== false && { ownershipCommittedAt: createdAt }),
      ...(input.state === 'ready' && { readyAt: createdAt }),
      ...(input.state === 'blocked' && { blockedAt: createdAt }),
    };

    this.records.set(sequence, record);
    this.targetToSequence.set(input.targetId, sequence);
    this.prune();
    return { ...record };
  }

  markReady(
    targetId: string,
    metadata: { url?: string; title?: string },
    at = Date.now(),
  ): boolean {
    const record = this.getMutable(targetId);
    if (!record || record.blockedAt !== undefined) return false;
    if (record.state === 'closed' && record.readyAt === undefined) return false;

    if (record.state !== 'closed') record.state = 'ready';
    record.readyAt ??= at;
    if (metadata.url !== undefined) record.url = sanitizeTargetUrl(metadata.url);
    if (metadata.title !== undefined) record.title = sanitizeTargetTitle(metadata.title);
    return true;
  }

  markOwnershipCommitted(targetId: string, at = Date.now()): boolean {
    const record = this.getMutable(targetId);
    if (!record || record.state === 'blocked' || record.state === 'closed') return false;
    record.ownershipCommittedAt ??= at;
    return true;
  }

  canCommitOwnership(targetId: string): boolean {
    const record = this.getMutable(targetId);
    return !!record && record.state !== 'blocked' && record.state !== 'closed';
  }

  markBlocked(targetId: string, at = Date.now()): boolean {
    const record = this.getMutable(targetId);
    if (!record) return false;
    record.state = 'blocked';
    record.blockedAt ??= at;
    record.url = '';
    record.title = '';
    return true;
  }

  markClosed(targetId: string, at = Date.now()): boolean {
    const record = this.getMutable(targetId);
    if (!record) return false;
    if (record.state !== 'blocked') record.state = 'closed';
    record.closedAt ??= at;
    return true;
  }

  remapTargetId(oldTargetId: string, newTargetId: string): boolean {
    if (oldTargetId === newTargetId) return this.has(oldTargetId);
    const sequence = this.targetToSequence.get(oldTargetId);
    if (sequence !== undefined) {
      const conflictingSequence = this.targetToSequence.get(newTargetId);
      if (conflictingSequence !== undefined && conflictingSequence !== sequence) return false;
      const record = this.records.get(sequence);
      if (record) {
        this.targetToSequence.delete(oldTargetId);
        record.targetId = newTargetId;
        this.targetToSequence.set(newTargetId, sequence);
      }
    }

    let remapped = sequence !== undefined;
    for (const record of this.records.values()) {
      if (record.currentOpenerTargetId === oldTargetId) {
        record.currentOpenerTargetId = newTargetId;
        remapped = true;
      }
    }
    return remapped;
  }

  reconcileAliveTargetIds(aliveTargetIds: Set<string>, at = Date.now()): void {
    for (const record of this.records.values()) {
      if (
        (record.state === 'provisional' || record.state === 'ready') &&
        !aliveTargetIds.has(record.targetId)
      ) {
        this.markClosed(record.targetId, at);
      }
    }
  }

  clearSession(sessionId: string): void {
    this.removeWhere((record) => record.sessionId === sessionId);
  }

  clearWorker(sessionId: string, workerId: string): void {
    this.removeWhere((record) => record.sessionId === sessionId && record.workerId === workerId);
  }

  query(input: TargetCreationQuery): TargetCreationQueryResult {
    const limit = Math.max(0, Math.min(input.limit ?? 5, 5));
    const eligible: TargetCreationRecord[] = [];
    let pendingCount = 0;

    for (const record of this.records.values()) {
      if (record.sequence <= input.afterSequence) continue;
      if (record.sessionId !== input.sessionId || record.workerId !== input.workerId) continue;
      if (record.currentOpenerTargetId !== input.openerTargetId) continue;

      if (
        record.blockedAt === undefined &&
        record.state !== 'closed' &&
        (record.state === 'provisional' || record.ownershipCommittedAt === undefined)
      ) {
        pendingCount++;
      }
      if (
        record.readyAt === undefined ||
        record.ownershipCommittedAt === undefined ||
        record.blockedAt !== undefined
      ) continue;
      eligible.push(record);
    }

    const tabs = eligible.slice(0, limit).map((record): OpenedTabFact => ({
      tabId: sanitizeText(record.targetId, MAX_ID_LENGTH),
      workerId: sanitizeText(record.workerId, MAX_ID_LENGTH),
      url: record.url,
      title: record.title,
      status: record.state === 'closed' ? 'closed' : 'ready',
    }));

    return {
      total: eligible.length,
      truncated: eligible.length > tabs.length,
      pendingCount,
      tabs,
    };
  }

  private getMutable(targetId: string): TargetCreationRecord | undefined {
    const sequence = this.targetToSequence.get(targetId);
    return sequence === undefined ? undefined : this.records.get(sequence);
  }

  private prune(): void {
    while (this.records.size > this.maxRecords) {
      let sequenceToDelete: number | undefined;
      for (const [sequence, record] of this.records) {
        if (record.state === 'blocked' || record.state === 'closed') {
          sequenceToDelete = sequence;
          break;
        }
      }
      sequenceToDelete ??= this.records.keys().next().value;
      if (sequenceToDelete === undefined) return;
      this.removeSequence(sequenceToDelete);
    }
  }

  private removeWhere(predicate: (record: TargetCreationRecord) => boolean): void {
    for (const [sequence, record] of Array.from(this.records.entries())) {
      if (predicate(record)) this.removeSequence(sequence);
    }
  }

  private removeSequence(sequence: number): void {
    const record = this.records.get(sequence);
    if (!record) return;
    this.records.delete(sequence);
    if (this.targetToSequence.get(record.targetId) === sequence) {
      this.targetToSequence.delete(record.targetId);
    }
  }
}
