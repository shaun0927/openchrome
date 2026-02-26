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

/** CDP protocol timeout in milliseconds. Prevents 180s default hangs. */
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

/** Session initialization timeout when autoLaunch is enabled (ms).
 *  Accounts for: port probe (5s) + Chrome launch (30s) + puppeteer connect (15s). */
export const DEFAULT_SESSION_INIT_TIMEOUT_AUTO_LAUNCH_MS = 45000;
