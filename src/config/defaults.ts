/**
 * Shared default constants used across the codebase.
 *
 * Any value that appears in 2+ files belongs here.
 * Update this single file instead of hunting across tools/cdp/chrome.
 */

/** WebP screenshot quality (0-100). Directly affects LLM token consumption via base64 size. */
export const DEFAULT_SCREENSHOT_QUALITY = 60;

/** Maximum characters returned in page content output (read_page, DOM serializer, batch_paginate). */
export const MAX_OUTPUT_CHARS = 50000;

/** Default browser viewport dimensions. */
export const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;

/** Default navigation timeout in milliseconds. */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;

/** Maximum number of candidate elements returned by element-finding queries. */
export const MAX_SEARCH_CANDIDATES = 30;

/** CDP protocol timeout in milliseconds. Prevents 180s default hangs.
 *  Override with OPENCHROME_PROTOCOL_TIMEOUT_MS environment variable. */
export const DEFAULT_PROTOCOL_TIMEOUT_MS = 30000;

/** Screenshot-specific timeout. Shorter than protocol timeout for fast fallback. */
export const DEFAULT_SCREENSHOT_TIMEOUT_MS = 15000;

/** Maximum number of tabs (targets) per worker. Oldest tab is closed when limit is reached. */
export const DEFAULT_MAX_TARGETS_PER_WORKER = 5;

/** Memory pressure threshold in bytes (500MB). Below this free memory, aggressive cleanup triggers. */
export const DEFAULT_MEMORY_PRESSURE_THRESHOLD = 500 * 1024 * 1024;

/** Cookie scan overall timeout in milliseconds. Prevents N×30s cascading hangs in parallel sessions. */
export const DEFAULT_COOKIE_SCAN_TIMEOUT_MS = 5000;

/** Per-candidate cookie probe timeout in milliseconds. Skips unresponsive tabs quickly. */
export const DEFAULT_COOKIE_SCAN_PER_TARGET_TIMEOUT_MS = 2000;

/** Maximum candidates to probe during cookie source scan. */
export const DEFAULT_COOKIE_SCAN_MAX_CANDIDATES = 5;

/** Overall cookie copy timeout in milliseconds. */
export const DEFAULT_COOKIE_COPY_TIMEOUT_MS = 10000;

/** Safe page.title() timeout in milliseconds. Prevents hangs on frozen renderers. */
export const DEFAULT_SAFE_TITLE_TIMEOUT_MS = 3000;

/** Per-item timeout in request queue (ms). Safety net against indefinitely hung CDP commands. */
export const DEFAULT_QUEUE_ITEM_TIMEOUT_MS = 120000;

/** Global tool execution timeout in milliseconds. Absolute safety net against indefinitely hung handlers. */
export const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 120000;

/** Session initialization timeout (getOrCreateSession). Prevents pre-handler hangs. */
export const DEFAULT_SESSION_INIT_TIMEOUT_MS = 30000;

/** Reconnect timeout in milliseconds. Prevents indefinite hang between retry races. */
export const DEFAULT_RECONNECT_TIMEOUT_MS = 15000;

/** New page creation timeout in milliseconds. Chrome can hang on Target.createTarget under load. */
export const DEFAULT_NEW_PAGE_TIMEOUT_MS = 15000;

/** Page configuration timeout (setViewport, etc.) in milliseconds. */
export const DEFAULT_PAGE_CONFIG_TIMEOUT_MS = 5000;

/** Cookie context operation timeout in milliseconds. */
export const DEFAULT_COOKIE_CONTEXT_TIMEOUT_MS = 5000;

/** Storage state restore timeout in milliseconds. */
export const DEFAULT_STORAGE_STATE_RESTORE_TIMEOUT_MS = 10000;

/** Storage state watchdog interval in milliseconds.
 *  How frequently cookies and localStorage are persisted to disk.
 *  Override with OPENCHROME_WATCHDOG_INTERVAL_MS environment variable. */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 30000;

/** createTarget aggregate timeout in milliseconds. Safety net for entire tab creation chain. */
export const DEFAULT_CREATE_TARGET_TIMEOUT_MS = 60000;

/** CDP session operation timeout for direct createCDPSession calls. */
export const DEFAULT_CDP_SESSION_OP_TIMEOUT_MS = 10000;

/** Operation gate timeout in milliseconds. Max wait when tool execution is paused. */
export const DEFAULT_OPERATION_GATE_TIMEOUT_MS = 300000;

/** Explicit timeout for puppeteer.connect() WebSocket connection (ms).
 *  protocolTimeout only covers CDP messages, not the initial WebSocket handshake.
 *  Without this, a listening but unresponsive Chrome can block for OS TCP timeout (60-120s). */
export const DEFAULT_PUPPETEER_CONNECT_TIMEOUT_MS = 15000;

/** Chrome launch timeout in milliseconds. How long to wait for debug port after spawning Chrome.
 *  Override with CHROME_LAUNCH_TIMEOUT_MS environment variable. */
export const DEFAULT_CHROME_LAUNCH_TIMEOUT_MS = 60000;

/** Session initialization timeout when autoLaunch is enabled (ms).
 *  Must be LONGER than DEFAULT_CHROME_LAUNCH_TIMEOUT_MS (60s) to allow the launcher's
 *  own error (with stderr diagnostics) to propagate instead of a generic timeout. */
export const DEFAULT_SESSION_INIT_TIMEOUT_AUTO_LAUNCH_MS = 75000;

/** Heartbeat interval in milliseconds. How frequently the CDP connection health is probed.
 *  Override with OPENCHROME_HEARTBEAT_INTERVAL_MS environment variable.
 *  Lower values detect disconnects faster but increase Chrome CPU overhead. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;

/** Maximum number of reconnection attempts after a disconnect.
 *  Override with OPENCHROME_MAX_RECONNECT_ATTEMPTS environment variable.
 *  Set higher for long-running sessions where transient failures are expected. */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

/** Base delay between reconnection attempts in milliseconds.
 *  Actual delay uses exponential backoff: baseDelay * 2^(attempt-1) + jitter.
 *  Override with OPENCHROME_RECONNECT_DELAY_MS environment variable. */
export const DEFAULT_RECONNECT_DELAY_MS = 1000;

/** Heartbeat active ping timeout in milliseconds.
 *  Sends Browser.getVersion to detect half-open WebSocket connections
 *  (e.g., after macOS sleep/wake) that browser.isConnected() misses.
 *  Set higher than heartbeat interval (5s) to avoid false-positive disconnects
 *  when Chrome is under heavy CPU load (GC pauses, complex JS execution). */
export const DEFAULT_HEARTBEAT_PING_TIMEOUT_MS = 15000;

/** Connection verification staleness threshold in milliseconds.
 *  If the connection hasn't been verified (by heartbeat or probe) within this window,
 *  connect() triggers an active CDP probe before returning. */
export const DEFAULT_CONNECT_VERIFY_STALENESS_MS = 10000;

/** Screenshot race timeout in milliseconds.
 *  Used in computer/interact/click-element/batch-paginate as a safety net
 *  when racing screenshot capture against a timeout. */
export const DEFAULT_SCREENSHOT_RACE_TIMEOUT_MS = 7000;

/** Post-action DOM settle delay in milliseconds.
 *  Brief pause after clicks/interactions to let the DOM update before reading state. */
export const DEFAULT_DOM_SETTLE_DELAY_MS = 50;

/** Form submit settle delay in milliseconds.
 *  Longer pause after form submission to allow for potential navigation or re-render. */
export const DEFAULT_FORM_SUBMIT_SETTLE_MS = 100;

/** fill_form: Max time to poll for form fields on SPA pages (ms). */
export const DEFAULT_FILL_FORM_POLL_MS = 1500;

/** fill_form: Interval between polls when waiting for form fields (ms). */
export const DEFAULT_FILL_FORM_POLL_INTERVAL_MS = 300;

/** Default compression level for response compression. */
export const DEFAULT_COMPRESSION_LEVEL = 'light';

/** Default verbosity level for metadata injection in responses. */
export const DEFAULT_VERBOSITY = 'normal';

/** Minimum response size in bytes before compression is applied. */
export const COMPRESSION_MIN_BYTES = 500;

/** Per-call timeout for CDPClient.send() in milliseconds.
 *  Prevents a hung Chrome renderer from blocking indefinitely.
 *  The 120s tool execution timeout is the outer safety net, but this
 *  catches hangs at the individual CDP command level (15s). */
export const DEFAULT_CDP_SEND_TIMEOUT_MS = 15000;

/** Completion lock acquisition timeout in milliseconds.
 *  Safety net for the promise-based mutex in WorkflowEngine.
 *  If a previous lock holder's release() is never called (e.g. due to an
 *  unhandled exception outside the try/finally), this prevents permanent deadlock. */
export const DEFAULT_COMPLETION_LOCK_TIMEOUT_MS = 30000;

// ─── Self-Healing Architecture (#347) ──────────────────────────────────────

/** Chrome process watchdog check interval in milliseconds.
 *  How often to verify Chrome PID is still alive.
 *  Override with OPENCHROME_PROCESS_WATCHDOG_INTERVAL_MS environment variable. */
export const DEFAULT_PROCESS_WATCHDOG_INTERVAL_MS = 10000;

/** Per-tab renderer health probe interval in milliseconds.
 *  How often to check idle tabs for frozen/crashed renderers.
 *  Override with OPENCHROME_TAB_HEALTH_PROBE_INTERVAL_MS environment variable. */
export const DEFAULT_TAB_HEALTH_PROBE_INTERVAL_MS = 60000;

/** Per-tab renderer health probe timeout in milliseconds.
 *  Maximum time to wait for a tab's page.evaluate('1') to respond. */
export const DEFAULT_TAB_HEALTH_PROBE_TIMEOUT_MS = 5000;

/** Consecutive tab probe failures before marking as unhealthy. */
export const DEFAULT_TAB_UNHEALTHY_THRESHOLD = 3;

/** Consecutive tab probe failures before auto-eviction. */
export const DEFAULT_TAB_EVICTION_THRESHOLD = 5;

/** Session state persistence debounce interval in milliseconds.
 *  How long to wait after a session mutation before saving to disk. */
export const DEFAULT_SESSION_PERSIST_DEBOUNCE_MS = 5000;

/** Event loop monitor check interval in milliseconds. */
export const DEFAULT_EVENT_LOOP_CHECK_INTERVAL_MS = 200;

/** Event loop block warning threshold in milliseconds.
 *  Emit warning when blocked longer than this.
 *  Low enough to catch stalls before CDP commands time out. */
export const DEFAULT_EVENT_LOOP_WARN_THRESHOLD_MS = 200;

/** Health endpoint HTTP port. Avoids conflict with Node.js inspector (9229) and Chrome DevTools (9222).
 *  Override with OPENCHROME_HEALTH_PORT environment variable. */
export const DEFAULT_HEALTH_ENDPOINT_PORT = 9090;

/** Idle timeout for adaptive heartbeat mode transition in milliseconds.
 *  Switch to idle heartbeat mode after this long without tool calls. */
export const DEFAULT_HEARTBEAT_IDLE_TIMEOUT_MS = 300000;

/** Recovery mode duration in milliseconds.
 *  How long to use fast heartbeat (1s) after reconnection before switching to active. */
export const DEFAULT_HEARTBEAT_RECOVERY_DURATION_MS = 30000;

/** Stealth navigation settle time in milliseconds.
 *  How long to wait with no CDP attached before attaching to the page.
 *  Turnstile challenges typically complete in 6-8 seconds.
 *  Override with stealthSettleMs parameter on navigate tool. */
export const DEFAULT_STEALTH_SETTLE_MS = 8000;

/** Whether to restore Chrome's previous session tabs after crash (default: false).
 *  Enable for long-running sessions where tab preservation matters.
 *  Override with OPENCHROME_RESTORE_LAST_SESSION=true environment variable. */
export const DEFAULT_RESTORE_LAST_SESSION = false;
