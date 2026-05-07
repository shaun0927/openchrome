/**
 * Skill-graph audit telemetry.
 *
 * The graph executor (#703) emits one structured event per outcome so an
 * operator can answer "did the system use the graph or fall back?" from
 * the audit log. The events ride on the existing `logAuditEntry` writer
 * — no new file, no new format. The `tool` field is fixed to
 * `skill_graph` and the kind is encoded in `args.event`.
 *
 * Schema (rendered as ExtendedAuditEntry.args):
 *   { event: "graph_hit"  | "graph_miss" | "graph_fallback_promoted",
 *     domain: string,
 *     fromState: string,
 *     toState?: string,
 *     actionKind?: string,
 *     ok: boolean,
 *     reason?: string,
 *     matchedExpected?: boolean }
 */

import { logAuditEntry } from '../security/audit-logger';

import type { RunOutcomeKind, RunSkillResult } from './executor';

export type GraphAuditEventKind = RunOutcomeKind;

export interface GraphAuditEvent {
  event: GraphAuditEventKind;
  domain: string;
  fromState: string;
  toState?: string;
  actionKind?: string;
  actionArgsNorm?: string;
  ok: boolean;
  reason?: string;
  matchedExpected?: boolean;
}

/** Hook the executor invokes after each step. Tests can substitute a fake. */
export interface GraphAuditEmitter {
  emit(event: GraphAuditEvent): void;
}

/**
 * Default emitter that writes to `~/.openchrome/audit.jsonl` via the
 * existing audit pipeline. Bound to a sessionId at construction time so
 * each call site doesn't have to thread it through.
 */
export class AuditLogGraphEmitter implements GraphAuditEmitter {
  constructor(private readonly sessionId: string, private readonly domain: string) {}

  emit(event: GraphAuditEvent): void {
    // Tool name is fixed; the event kind lives in args so existing audit
    // tooling can filter via a single field path (`args.event`).
    logAuditEntry(
      'skill_graph',
      this.sessionId,
      // logAuditEntry expects Record<string, unknown> — coerce via spread.
      { ...event } as unknown as Record<string, unknown>,
      undefined,
      { status: event.ok ? 'success' : 'error' },
    );
  }
}

/** Build a `GraphAuditEvent` from a `RunSkillResult`. Pure; safe to test. */
export function buildEventFromResult(
  domain: string,
  result: RunSkillResult,
): GraphAuditEvent {
  return {
    event: result.outcome,
    domain,
    fromState: result.fromState,
    toState: result.toState,
    actionKind: result.action?.kind,
    actionArgsNorm: result.action?.argsNorm,
    ok: result.ok,
    reason: result.reason,
    matchedExpected: result.matchedExpected,
  };
}

/**
 * Convenience helper — call from executor wrappers that already have a
 * `RunSkillResult` and want one-line emission.
 */
export function emitGraphEvent(
  emitter: GraphAuditEmitter | undefined,
  domain: string,
  result: RunSkillResult,
): void {
  if (!emitter) return;
  emitter.emit(buildEventFromResult(domain, result));
}
