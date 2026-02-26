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
