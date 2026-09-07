import { randomUUID } from 'node:crypto';

interface Operation {
  sessionId: string; targets: string[]; tool: string; write: boolean;
  startedAt: number; endedAt?: number; status: 'running' | 'completed' | 'error';
}
interface Handoff { sessionId: string; lease: string; requestedAt: number }

export class BrowserAdmissionError extends Error {
  readonly execution = 'not_started';
  constructor(readonly code: 'HUMAN_CONTROL_PENDING' | 'OPERATION_CAPACITY') {
    super(`${code}: browser operation was not started`);
  }
}

/** Bounded facts and input ownership, not a task planner. Unknown write scope conflicts conservatively. */
export class BrowserOperations {
  private active = new Set<Operation>();
  private recent: Operation[] = [];
  private handoffs = new Map<string, Handoff>();

  begin(sessionId: string, targets: string[], tool: string, write: boolean): (ok: boolean) => void {
    if (write && [...this.handoffs.keys()].some(target => targets.length === 0 || targets.includes(target))) {
      throw new BrowserAdmissionError('HUMAN_CONTROL_PENDING');
    }
    if (this.active.size >= 256) throw new BrowserAdmissionError('OPERATION_CAPACITY');
    const operation: Operation = { sessionId, targets: [...targets], tool, write, startedAt: Date.now(), status: 'running' };
    this.active.add(operation);
    return ok => {
      if (!this.active.delete(operation)) return;
      operation.status = ok ? 'completed' : 'error';
      operation.endedAt = Date.now();
      this.recent.push(operation);
      if (this.recent.length > 128) this.recent.shift();
    };
  }

  status(sessionId: string, target: string) {
    const affects = (op: Operation): boolean => op.targets.length === 0 || op.targets.includes(target);
    const writes = [...this.active].filter(op => op.write && affects(op));
    const handoff = this.handoffs.get(target);
    const owned = handoff?.sessionId === sessionId ? handoff : undefined;
    const visible = (op: Operation): boolean => op.sessionId === sessionId && affects(op);
    return {
      observedAt: Date.now(), phase: owned ? (writes.length ? 'draining' : 'human') : 'automation',
      pendingWrites: writes.length,
      drainGuarantee: 'tracked_tool_handlers_only; page timers and background requests are not frozen',
      ...(owned ? { lease: owned.lease, requestedAt: owned.requestedAt } : {}),
      active: [...this.active].filter(visible).map(op => ({ tool: op.tool, startedAt: op.startedAt, status: op.status })),
      recent: this.recent.filter(visible).slice(-8).map(op => ({ tool: op.tool, startedAt: op.startedAt, endedAt: op.endedAt, status: op.status })),
    };
  }

  pause(sessionId: string, target: string) {
    const existing = this.handoffs.get(target);
    if (existing && existing.sessionId !== sessionId) throw new Error('Target control belongs to another session');
    if (!existing) this.handoffs.set(target, { sessionId, lease: randomUUID(), requestedAt: Date.now() });
    return this.status(sessionId, target);
  }

  assertResumable(sessionId: string, target: string, lease: string): void {
    const handoff = this.handoffs.get(target);
    if (!handoff || handoff.sessionId !== sessionId || handoff.lease !== lease) throw new Error('Invalid control lease');
    if (this.status(sessionId, target).phase !== 'human') throw new Error('Automatic input is still draining');
  }

  resume(sessionId: string, target: string, lease: string): void {
    this.assertResumable(sessionId, target, lease);
    this.handoffs.delete(target);
  }

  hasHandoff(sessionId: string): boolean { return [...this.handoffs.values()].some(value => value.sessionId === sessionId); }

  removeTarget(target: string): void { this.handoffs.delete(target); }
  clear(): void { this.handoffs.clear(); this.recent = []; }
}

export function operationTargets(args: Record<string, unknown>): string[] {
  return [...new Set([args.tabId, ...(Array.isArray(args.tabIds) ? args.tabIds : [])]
    .filter((target): target is string => typeof target === 'string' && target.length > 0))];
}
