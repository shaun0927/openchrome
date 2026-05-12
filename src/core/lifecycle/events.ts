/**
 * Closed discriminated union of browser-lifecycle events emitted on the
 * process-wide LifecycleEventBus (issue #857).
 *
 * Every variant carries a `kind` discriminator and a `ts` timestamp
 * (`Date.now()` at emit site). Producers in `src/chrome/`, `src/session-manager.ts`,
 * and (with `--pilot`) `src/pilot/runtime/` emit these from already-existing
 * internal transitions — they do not introduce new state.
 *
 * Consumers subscribe via `LifecycleEventBus.on(kind | '*', ...)` and MUST
 * NOT depend on emit ordering across kinds. Ordering is FIFO within a single
 * `emit()` call only.
 */

export type ChromeExitReason =
  | 'sigterm'
  | 'crash'
  | 'idle'
  | 'orphan-reap'
  | 'unknown';

export type LifecycleMode = 'isolated' | 'attach';

export type SessionDestroyReason = 'ttl' | 'close' | 'shutdown';

export type LifecycleEvent =
  | {
      kind: 'chrome:launch';
      pid: number;
      port: number;
      userDataDir: string;
      lifecycleMode: LifecycleMode;
      ts: number;
    }
  | {
      kind: 'chrome:exit';
      pid: number;
      reason: ChromeExitReason;
      classification?: string;
      ts: number;
    }
  | {
      kind: 'session:create';
      sessionId: string;
      tenantId: string;
      ts: number;
    }
  | {
      kind: 'session:destroy';
      sessionId: string;
      reason: SessionDestroyReason;
      ts: number;
    }
  | {
      kind: 'worker:create';
      sessionId: string;
      workerId: string;
      ts: number;
    }
  | {
      kind: 'worker:destroy';
      sessionId: string;
      workerId: string;
      ts: number;
    }
  | {
      kind: 'target:create';
      sessionId: string;
      workerId: string;
      targetId: string;
      url: string;
      ts: number;
    }
  | {
      kind: 'target:navigate';
      sessionId: string;
      workerId: string;
      targetId: string;
      fromUrl: string;
      toUrl: string;
      ts: number;
    }
  | {
      kind: 'target:close';
      sessionId: string;
      workerId: string;
      targetId: string;
      ts: number;
    }
  | {
      kind: 'irreversible-action:before';
      sessionId: string;
      targetId: string;
      action: string;
      ts: number;
    };

/** All possible discriminator values, useful for routing and tests. */
export type LifecycleEventKind = LifecycleEvent['kind'];

/** Wildcard subscription key — matches any kind. */
export const WILDCARD = '*' as const;
export type WildcardKey = typeof WILDCARD;
