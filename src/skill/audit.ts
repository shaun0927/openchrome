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
 *   { event: "graph_hit" | "graph_miss" | "graph_fallback_promoted"
 *           | "graph_error",
 *     domain: string,
 *     fromState: string,
 *     toState?: string,
 *     actionKind?: string,
 *     ok: boolean,
 *     reason?: string,
 *     matchedExpected?: boolean }
 *
 * `graph_error` is emitted when `runSkill` itself rejects (snapshot,
 * router, or storage failure). The 1:1 call-to-event guarantee covers
 * exception paths so operational dashboards never undercount failures.
 */

import { logAuditEntry } from '../security/audit-logger';

import type {
  ActionInvocation,
  RunOutcomeKind,
  RunSkillResult,
} from './executor';

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
 *
 * The constructor takes a `defaultDomain` used only when the event's
 * `domain` field is empty — `event.domain` is authoritative because the
 * caller can override it per call via `RunSkillArgs.domain`.
 */
export class AuditLogGraphEmitter implements GraphAuditEmitter {
  constructor(
    private readonly sessionId: string,
    private readonly defaultDomain: string,
  ) {}

  emit(event: GraphAuditEvent): void {
    // Tool name is fixed; the event kind lives in args so existing audit
    // tooling can filter via a single field path (`args.event`).
    //
    // `logAuditEntry` derives the top-level `entry.domain` from either
    // the `pageUrl` argument or `args.url`. Skill graph events have
    // neither, so we synthesise a stand-in URL from the *event's* domain
    // (falling back to the bound default) so per-call domain overrides
    // are reflected in `entry.domain`, not just in `args.domain`.
    const domain = event.domain || this.defaultDomain;
    const domainUrl = synthesiseDomainUrl(domain);
    logAuditEntry(
      'skill_graph',
      this.sessionId,
      // logAuditEntry expects Record<string, unknown> — coerce via spread.
      { ...event } as unknown as Record<string, unknown>,
      domainUrl,
      { status: event.ok ? 'success' : 'error' },
    );
  }
}

/**
 * Build a URL that `extractHostname()` can parse back into the original
 * domain. Skill-graph domains arrive without a scheme (e.g. `amazon.com`,
 * `localhost:3000`) — wrap them in `https://…/` for the URL parser. If the
 * input is already a URL we leave it alone.
 */
function synthesiseDomainUrl(domain: string): string {
  if (!domain) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(domain)) return domain;
  return `https://${domain}/`;
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
 * Build a `graph_error` event from whatever progress the executor managed
 * to capture before throwing. `fromState`/`toState`/`action` may be
 * undefined when the snapshot itself failed; callers must tolerate that
 * — the `event` and `ok=false` fields are sufficient to count failures.
 */
export function buildEventFromError(
  domain: string,
  err: unknown,
  trace: { fromState?: string; toState?: string; action?: ActionInvocation },
): GraphAuditEvent {
  const reason =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown_error';
  return {
    event: 'graph_error',
    domain,
    fromState: trace.fromState ?? '',
    toState: trace.toState,
    actionKind: trace.action?.kind,
    actionArgsNorm: trace.action?.argsNorm,
    ok: false,
    reason,
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
