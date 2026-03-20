/**
 * Self-Healing Architecture — Barrel exports for #347 modules.
 */

export { ChromeProcessWatchdog } from './chrome/process-watchdog';
export type { ProcessWatchdogOptions, ProcessWatchdogEvents } from './chrome/process-watchdog';

export { SessionStatePersistence } from './session-state-persistence';
export type { PersistedSessionState, PersistedSession, PersistedWorker, PersistedTarget } from './session-state-persistence';

export { TabHealthMonitor } from './cdp/tab-health-monitor';
export type { TabHealthMonitorOptions, TabHealthInfo, TabHealthStatus } from './cdp/tab-health-monitor';

export { EventLoopMonitor } from './watchdog/event-loop-monitor';
export type { EventLoopMonitorOptions, BlockEvent } from './watchdog/event-loop-monitor';

export { HealthEndpoint } from './watchdog/health-endpoint';
export type { HealthData, HealthDataProvider } from './watchdog/health-endpoint';
