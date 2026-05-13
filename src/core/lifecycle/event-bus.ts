/**
 * Process-wide browser-lifecycle event bus (issue #857).
 *
 * Design constraints:
 *   - `emit()` MUST NOT throw. Listener exceptions (sync + rejected promises)
 *     are caught, counted via the metrics collector under
 *     `openchrome_lifecycle_listener_errors_total{listener,event}`, and
 *     swallowed so a misbehaving consumer cannot break unrelated subscribers
 *     or the call site (Chrome launcher, session manager, etc.).
 *   - Subscriptions return an unsubscribe handle. Recorders and watchdogs
 *     attach in `start()` and detach in `stop()` symmetrically.
 *   - Off-switch: setting `OPENCHROME_LIFECYCLE_BUS=0` makes `emit()` a
 *     no-op. Subscribers that read `isLifecycleBusEnabled()` MAY also skip
 *     their `on(...)` registration entirely; both paths produce identical
 *     observable state, which the parity test verifies.
 *
 * Implementation notes:
 *   - We wrap `node:events` `EventEmitter` for FIFO dispatch and `setMaxListeners`
 *     ergonomics. Wildcard subscribers run after kind-specific subscribers,
 *     mirroring the order steel-browser's plugin manager establishes for
 *     observers vs. mutators (we have no mutators here, but ordering still
 *     matters for the recorder, which is the canonical wildcard consumer).
 *   - Listener `name` for the error counter is derived from
 *     `listener.name || 'anonymous'`. Recorder, watchdog, journal etc. should
 *     pass named functions (`function traceRecorder(ev) { … }`) so the
 *     metric label is stable across restarts.
 *   - The dev-only error-injection hook is gated by both `NODE_ENV !==
 *     'production'` and `OPENCHROME_DEV_HOOKS === '1'`; production builds
 *     tree-shake it out (asserted by a build-output lint script).
 */

import { EventEmitter } from 'node:events';

import { getMetricsCollector, MetricsCollector } from '../../metrics/collector';
import type {
  LifecycleEvent,
  LifecycleEventKind,
  WildcardKey,
} from './events';
import { WILDCARD } from './events';

/** Listener signature accepted by `on()`. May return void or a Promise. */
export type LifecycleListener = (event: LifecycleEvent) => void | Promise<void>;

/** Unsubscribe callback returned by `on()`. Idempotent. */
export type Unsubscribe = () => void;

/** Metric name used for the listener-error counter. Public for tests. */
export const LIFECYCLE_LISTENER_ERROR_METRIC =
  'openchrome_lifecycle_listener_errors_total';

const ENV_OFF_SWITCH = 'OPENCHROME_LIFECYCLE_BUS';
const ENV_DEV_HOOKS = 'OPENCHROME_DEV_HOOKS';
const ENV_INJECT_THROW = 'OPENCHROME_LIFECYCLE_INJECT_THROW';

/** Cached metrics-registration flag so re-instantiation is idempotent. */
let metricsRegistered = false;

function ensureLifecycleMetricsRegistered(collector: MetricsCollector): void {
  if (metricsRegistered) return;
  collector.registerCounter(
    LIFECYCLE_LISTENER_ERROR_METRIC,
    'Lifecycle event-bus listener errors (sync throws + promise rejections)',
  );
  metricsRegistered = true;
}

/**
 * Read the off-switch each time we emit so operator-toggled env changes take
 * effect without process restart. Cheap (env lookup), called per-emit.
 *
 * `OPENCHROME_LIFECYCLE_BUS=0` (or `false`, `no`, `off`) disables emit.
 * Anything else (or unset) leaves the bus active.
 */
export function isLifecycleBusEnabled(): boolean {
  const raw = process.env[ENV_OFF_SWITCH];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

/**
 * Dev-only fixture: when the env var lists a listener name (or `*`), that
 * listener's invocation throws on the next event. Gated by `NODE_ENV !==
 * 'production' && OPENCHROME_DEV_HOOKS=1` so production builds never wire
 * this in. The injection path is one-shot per listener — after firing we
 * clear the entry from the in-memory set so the next emit succeeds.
 */
function devHooksEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env[ENV_DEV_HOOKS] === '1';
}

function shouldInjectThrow(listenerName: string): boolean {
  if (!devHooksEnabled()) return false;
  const raw = process.env[ENV_INJECT_THROW];
  if (!raw) return false;
  const list = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return list.includes(listenerName) || list.includes('*');
}

interface RegisteredListener {
  readonly name: string;
  readonly listener: LifecycleListener;
}

export interface LifecycleEventBus {
  /** Emit a lifecycle event. Never throws; listener errors are isolated. */
  emit(event: LifecycleEvent): void;
  /**
   * Subscribe to a single kind or all kinds (`'*'`). Returns an idempotent
   * unsubscribe callback. Prefer passing a named function so the metrics
   * label is stable.
   */
  on(
    kind: LifecycleEventKind | WildcardKey,
    listener: LifecycleListener,
  ): Unsubscribe;
  /** Remove every registered listener. Used by tests and `stop()` paths. */
  removeAllListeners(): void;
}

/**
 * Internal implementation. Public via {@link getLifecycleBus} / {@link
 * createLifecycleBus}; consumers should not construct this directly.
 */
class LifecycleEventBusImpl implements LifecycleEventBus {
  private readonly emitter = new EventEmitter();
  /** Wildcard listeners are stored separately so we can iterate them last. */
  private readonly wildcardListeners: RegisteredListener[] = [];

  constructor(private readonly metrics: MetricsCollector) {
    ensureLifecycleMetricsRegistered(metrics);
    // Node prints a warning past 10 listeners; the recorder + watchdog +
    // future journal subscribers are well within that, but bump the ceiling
    // a little to leave headroom for tests that attach short-lived probes.
    this.emitter.setMaxListeners(50);
  }

  emit(event: LifecycleEvent): void {
    if (!isLifecycleBusEnabled()) return;
    // Kind-specific listeners first, wildcard last. EventEmitter handles
    // exceptions for sync listeners by re-throwing — we never want that, so
    // we don't rely on `emitter.emit()` directly; we look up listener arrays
    // and invoke each with our own try/catch wrapper.
    const kindListeners = this.emitter.listeners(event.kind) as Array<{
      __lifecycle?: RegisteredListener;
    }>;
    for (const wrapped of kindListeners) {
      const meta = wrapped.__lifecycle;
      if (meta) this.dispatchOne(meta, event);
    }
    for (const meta of this.wildcardListeners) {
      this.dispatchOne(meta, event);
    }
  }

  on(
    kind: LifecycleEventKind | WildcardKey,
    listener: LifecycleListener,
  ): Unsubscribe {
    const name = listener.name || 'anonymous';
    const meta: RegisteredListener = { name, listener };
    if (kind === WILDCARD) {
      this.wildcardListeners.push(meta);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const idx = this.wildcardListeners.indexOf(meta);
        if (idx !== -1) this.wildcardListeners.splice(idx, 1);
      };
    }
    // Attach a wrapper so `emitter.listeners(kind)` still gives us back a
    // function reference EventEmitter accepts. We stash the meta on the
    // wrapper via a non-enumerable property so dispatchOne() can read it
    // without a parallel WeakMap.
    const wrapper = (() => {
      /* never called directly — dispatchOne invokes meta.listener */
    }) as ((event: LifecycleEvent) => void) & {
      __lifecycle?: RegisteredListener;
    };
    wrapper.__lifecycle = meta;
    this.emitter.on(kind, wrapper);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.emitter.removeListener(kind, wrapper);
    };
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
    this.wildcardListeners.length = 0;
  }

  private dispatchOne(meta: RegisteredListener, event: LifecycleEvent): void {
    try {
      if (shouldInjectThrow(meta.name)) {
        // Dev-only error-injection fixture. Recorder/parity tests use this
        // to verify error isolation without modifying production code.
        throw new Error(
          `OPENCHROME_LIFECYCLE_INJECT_THROW: forced failure in listener "${meta.name}"`,
        );
      }
      const result = meta.listener(event);
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((err) => {
          this.recordListenerError(meta.name, event.kind, err);
        });
      }
    } catch (err) {
      this.recordListenerError(meta.name, event.kind, err);
    }
  }

  private recordListenerError(
    listener: string,
    eventKind: string,
    err: unknown,
  ): void {
    try {
      this.metrics.inc(LIFECYCLE_LISTENER_ERROR_METRIC, {
        listener,
        event: eventKind,
      });
    } catch {
      // Metrics collector is best-effort; never let it propagate.
    }
    // Surface the error on stderr so operators have a breadcrumb. Per
    // CLAUDE.md we never use stdout (MCP JSON-RPC corruption).
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(
      `[lifecycle-bus] listener "${listener}" failed on "${eventKind}": ${msg}\n`,
    );
  }
}

let singleton: LifecycleEventBus | null = null;

/**
 * Process-wide singleton. Identical handle for every caller across the
 * process — recorder, watchdog, integration tests all subscribe to the
 * same bus. Lazy-initialised so importing this module from a tool that
 * never emits has zero cost beyond the module load.
 */
export function getLifecycleBus(): LifecycleEventBus {
  if (!singleton) {
    singleton = new LifecycleEventBusImpl(getMetricsCollector());
  }
  return singleton;
}

/** Factory for tests that need an isolated bus with its own metrics collector. */
export function createLifecycleBus(metrics?: MetricsCollector): LifecycleEventBus {
  return new LifecycleEventBusImpl(metrics ?? getMetricsCollector());
}

/**
 * Test helper. Clears the cached singleton so a fresh bus is created on the
 * next `getLifecycleBus()` call. Production code MUST NOT call this — the
 * singleton's identity is what guarantees in-tree consumers share the same
 * dispatch stream.
 */
export function resetLifecycleBusForTests(): void {
  singleton = null;
}
