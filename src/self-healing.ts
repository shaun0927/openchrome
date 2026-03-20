/**
 * Self-Healing Architecture — Integration Guide
 *
 * This file documents the modules added by #347 and how to wire them together.
 * Each module is independently importable from its own path.
 *
 * After all #347 PRs are merged, uncomment the barrel exports below.
 *
 * Modules:
 * - ChromeProcessWatchdog: src/chrome/process-watchdog.ts (#348)
 * - SessionStatePersistence: src/session-state-persistence.ts (#349)
 * - TabHealthMonitor: src/cdp/tab-health-monitor.ts (#350)
 * - EventLoopMonitor: src/watchdog/event-loop-monitor.ts (#351)
 * - HealthEndpoint: src/watchdog/health-endpoint.ts (#351)
 * - Adaptive Heartbeat: src/cdp/client.ts (getConnectionMetrics, setHeartbeatMode)
 *
 * Integration order:
 * 1. Import modules in src/mcp-server.ts or src/index.ts
 * 2. Instantiate in server startup:
 *    - const processWatchdog = new ChromeProcessWatchdog(launcher);
 *    - const tabHealthMonitor = new TabHealthMonitor();
 *    - const eventLoopMonitor = new EventLoopMonitor();
 *    - const sessionPersistence = new SessionStatePersistence();
 *    - const healthEndpoint = new HealthEndpoint(healthProvider);
 * 3. Start monitors: processWatchdog.start(), eventLoopMonitor.start()
 * 4. Wire events:
 *    - processWatchdog.on('chrome-relaunched', () => cdpClient.forceReconnect())
 *    - tabHealthMonitor.on('tab-evict', ({targetId}) => sessionManager.deleteTarget(...))
 *    - eventLoopMonitor.on('fatal', () => process.exit(1))
 * 5. Hook into session lifecycle:
 *    - On createTarget: tabHealthMonitor.monitorTab(targetId, page)
 *    - On deleteTarget: tabHealthMonitor.unmonitorTab(targetId)
 *    - On session mutation: sessionPersistence.scheduleSave(snapshot)
 * 6. Cleanup on shutdown:
 *    - processWatchdog.stop()
 *    - tabHealthMonitor.stopAll()
 *    - eventLoopMonitor.stop()
 *    - await healthEndpoint.stop()
 *    - sessionPersistence.cancelPendingSave()
 *
 * Constants (all in src/config/defaults.ts):
 * - DEFAULT_PROCESS_WATCHDOG_INTERVAL_MS (10s)
 * - DEFAULT_TAB_HEALTH_PROBE_INTERVAL_MS (60s)
 * - DEFAULT_TAB_HEALTH_PROBE_TIMEOUT_MS (5s)
 * - DEFAULT_TAB_UNHEALTHY_THRESHOLD (3)
 * - DEFAULT_TAB_EVICTION_THRESHOLD (5)
 * - DEFAULT_SESSION_PERSIST_DEBOUNCE_MS (5s)
 * - DEFAULT_EVENT_LOOP_CHECK_INTERVAL_MS (200ms)
 * - DEFAULT_EVENT_LOOP_WARN_THRESHOLD_MS (2s)
 * - DEFAULT_HEALTH_ENDPOINT_PORT (9229)
 * - DEFAULT_HEARTBEAT_IDLE_TIMEOUT_MS (5min)
 * - DEFAULT_HEARTBEAT_RECOVERY_DURATION_MS (30s)
 */

// Barrel exports will be activated after all #347 PRs are merged.
// For now, import each module directly from its own path.
export {};
