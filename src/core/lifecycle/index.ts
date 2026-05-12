/**
 * Barrel export for `src/core/lifecycle/` (issue #857).
 *
 * Public surface:
 *   - Event type union and individual variant accessors via `LifecycleEvent`.
 *   - `getLifecycleBus()` process-wide singleton (recorder, watchdog,
 *     integration tests, future journal subscribers).
 *   - `isLifecycleBusEnabled()` for opt-out callers that want to skip
 *     listener registration entirely when `OPENCHROME_LIFECYCLE_BUS=0`.
 *
 * Consumers in `src/pilot/**` MAY import from this module; per the
 * portability-harness contract (see .dependency-cruiser.cjs) the reverse
 * is not allowed.
 */

export type {
  ChromeExitReason,
  LifecycleEvent,
  LifecycleEventKind,
  LifecycleMode,
  SessionDestroyReason,
  WildcardKey,
} from './events';
export { WILDCARD } from './events';
export {
  LIFECYCLE_LISTENER_ERROR_METRIC,
  createLifecycleBus,
  getLifecycleBus,
  isLifecycleBusEnabled,
  resetLifecycleBusForTests,
  type LifecycleEventBus,
  type LifecycleListener,
  type Unsubscribe,
} from './event-bus';
