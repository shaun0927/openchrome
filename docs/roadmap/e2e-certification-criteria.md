# OpenChrome E2E Certification Criteria

**Reliability Guarantee:** *Every tool call returns a result. OpenChrome never hangs.*

This document defines the exact test scenarios that must pass for OpenChrome to claim its reliability guarantee. Each criterion is precise and numerical. Vague language such as "should be fast" or "reasonable time" is not used anywhere in this document.

---

## Table of Contents

1. [Definitions and Conventions](#1-definitions-and-conventions)
2. [Test Infrastructure Reference](#2-test-infrastructure-reference)
3. [Existing Tests (E2E-1 through E2E-10)](#3-existing-tests-e2e-1-through-e2e-10)
4. [New Tests (E2E-11 through E2E-21)](#4-new-tests-e2e-11-through-e2e-21)
5. [Certification Matrix](#5-certification-matrix)
6. [Certification Rules](#6-certification-rules)

---

## 1. Definitions and Conventions

### Time Scale

All durations in this document are stated at **full scale (TIME_SCALE=1.0)**. CI environments compress durations using the `TIME_SCALE` environment variable. The CI compression factor is `0.167` (approximately 6x). Nightly runs use `TIME_SCALE=1.0`.

| Variable | CI (Push/PR) | Nightly | Local Dev |
|----------|-------------|---------|-----------|
| `TIME_SCALE` | `0.167` | `1.0` | `1.0` |

### Hang

A **hang** is defined as a tool call that does not return any response — success or error — within its stated timeout. A tool call that returns an error response is **not** a hang; it is a failure. A hang is always a certification-breaking defect.

### Recovery Time

**Recovery time** is measured from the moment a fault is induced (Chrome kill, network drop, process exit) until the moment a subsequent tool call returns a successful response. All recovery time assertions are hard limits, not averages, unless explicitly stated otherwise.

### Graceful Rejection

A **graceful rejection** is a JSON-RPC error response with a non-zero error code, returned within the call's timeout period. A graceful rejection is not a hang and is not a crash. Rate-limiter rejections must be graceful rejections.

### Heap Delta

**Heap delta** is the difference between the RSS (resident set size) of the MCP server process at the end of a test and the baseline RSS taken before the first tool call in that test. Measured by `HeapSampler` using cross-process RSS monitoring.

---

## 2. Test Infrastructure Reference

The following harness components are available to all tests:

| Component | File | Purpose |
|-----------|------|---------|
| `MCPClient` | `tests/e2e/harness/mcp-client.ts` | Spawns MCP server, sends JSON-RPC over stdin/stdout, enforces per-call timeouts |
| `HeapSampler` | `tests/e2e/harness/heap-sampler.ts` | Cross-process RSS monitoring with baseline and delta tracking |
| `ChromeController` | `tests/e2e/harness/chrome-controller.ts` | PID discovery via debug port, kill, relaunch detection |
| `FixtureServer` | `tests/e2e/harness/fixture-server.ts` | Deterministic HTTP test pages at `/`, `/site-a`, `/site-b`, `/site-c`, `/login`, `/protected` |
| `TIME_SCALE` / `scaled()` / `scaledSleep()` | `tests/e2e/harness/time-scale.ts` | CI time compression |
| `JEST_OVERHEAD_MS` | `tests/e2e/harness/time-scale.ts` | Fixed 30,000 ms Jest runner overhead added to all test timeouts |

All new tests must use `scaled()` for duration calculations and add `JEST_OVERHEAD_MS` to their Jest timeout.

---

## 3. Existing Tests (E2E-1 through E2E-10)

These tests are already implemented and passing. They are referenced here to establish context for the certification matrix. Their pass criteria are authoritative and must not be weakened.

| ID | Title | Pass Criteria (Summary) |
|----|-------|------------------------|
| E2E-1 | Marathon (60 min continuous) | Success rate ≥ 99%, heap delta < 50 MB |
| E2E-2 | Chrome Kill -9 Recovery | Total recovery time < 30 s, new Chrome PID differs from old |
| E2E-3 | MCP Server Restart | Restart completes < 30 s, 5 tabs navigable post-restart |
| E2E-4 | Auth Persistence | Cookies survive MCP server restart |
| E2E-5 | Tab Isolation | JS error in one tab does not prevent tool calls on other tabs |
| E2E-6 | Memory Stability / Pressure | Heap delta < 50 MB (stability) or < 100 MB (pressure), p95 response < 2× warm-up p95 |
| E2E-7 | Idle Session / Multi-site | Tool calls succeed after 20 min idle |
| E2E-8 | 24 h Endurance / Compaction Resume | Success rate > 95%, avg recovery < 30 s, heap growth < 200 MB |
| E2E-9 | Multi-profile | Profiles isolated; no cross-profile cookie leak |
| E2E-10 | Multi-profile Errors | Error in profile A does not affect profile B |

---

## 4. New Tests (E2E-11 through E2E-21)

---

### E2E-11: WebSocket Disconnect Without Process Death

**Category:** Connection Resilience

**Purpose:** Verify that OpenChrome detects a dropped WebSocket connection to Chrome (while the Chrome process remains alive) and automatically reconnects without losing in-flight state.

#### Preconditions

1. OpenChrome MCP server is running in stdio mode with `--auto-launch`.
2. Chrome is running and connected via CDP WebSocket on the debug port.
3. At least one tab has been navigated to a fixture URL (`/site-a`) and a `tabId` is known.
4. The harness has a mechanism to close the CDP WebSocket without killing Chrome (e.g., via `chrome.debugger.detach` CDP command, or by blocking/closing the socket at the OS level with `iptables -I OUTPUT -p tcp --dport <debug-port> -j DROP` followed by DROP removal).

#### Steps

1. Navigate to `http://localhost:{fixture-port}/site-a`. Record `tabId` and confirm `read_page` succeeds.
2. Record `t0 = Date.now()`.
3. Close the CDP WebSocket connection without sending SIGKILL or SIGTERM to the Chrome process. The Chrome process must remain alive (verify via `ChromeController.isRunning()` immediately after the disconnect).
4. Poll `ChromeController.isRunning()` every 500 ms to confirm Chrome stays alive throughout.
5. Wait for OpenChrome to detect the disconnect. Detection is confirmed when an internal heartbeat timeout fires. The heartbeat interval is defined by the `heartbeatIntervalMs` configuration parameter.
6. Poll: attempt `navigate` tool calls with a 5,000 ms per-call timeout, every 2,000 ms, until one succeeds or 20,000 ms elapses.
7. Record `t1 = Date.now()` when the first successful `navigate` returns.
8. Confirm `read_page` on the new `tabId` succeeds.
9. Confirm no data was lost: navigate back to the original URL and verify the page content is identical to step 1.

#### Pass Criteria

| Criterion | Threshold | Measurement |
|-----------|-----------|-------------|
| Chrome process alive throughout | Must be `true` at every poll in step 4 | `ChromeController.isRunning()` |
| Disconnect detection | Within 2 complete heartbeat cycles (≤ `2 × heartbeatIntervalMs` ms) | Internal log or reconnect attempt observed |
| Reconnect time `t1 - t0` | < 15,000 ms | Wall clock |
| First `navigate` after reconnect | Returns success (not error, not hang) | JSON-RPC response `result` present |
| `read_page` after reconnect | Returns non-empty text (length > 0) | Response content |
| Zero hangs | All tool calls in step 6 return (success or error) within 5,000 ms each | Per-call timeout |

#### Fail Criteria

- Any tool call in step 6 hangs (no response within 5,000 ms).
- `t1 - t0 ≥ 15,000 ms`.
- Chrome process dies during the test (process death invalidates this scenario; use E2E-12 instead).
- `read_page` in step 8 returns empty text.

#### Timeout

Full-scale: `scaled(60_000) + JEST_OVERHEAD_MS` = 60,000 ms + 30,000 ms = **90,000 ms**.

#### CI Strategy

Push/PR with TIME_SCALE=0.167. Duration compresses to ~10 s active phase. All assertions use wall-clock absolute values (not scaled), except the heartbeat detection window which scales with `heartbeatIntervalMs`.

---

### E2E-12: Infinite Reconnection (Chrome Down 5 Minutes)

**Category:** Connection Resilience

**Purpose:** Verify that OpenChrome does not abandon reconnection attempts when Chrome is unavailable for an extended period, and that it successfully reconnects when Chrome becomes available again.

#### Preconditions

1. OpenChrome MCP server is running in stdio mode with `--auto-launch`.
2. Chrome is running and a successful tool call has been made.
3. `ChromeController` has discovered the Chrome PID on the debug port.

#### Steps

1. Navigate to `http://localhost:{fixture-port}/` and confirm success. Record `t_kill`.
2. Send `SIGKILL` to the Chrome process via `ChromeController.kill('SIGKILL')`.
3. Confirm Chrome is dead: `ChromeController.isRunning()` returns `false` within 3,000 ms.
4. Wait `scaled(5 * 60 * 1000)` ms (5 minutes full-scale, ~50 s at CI scale). During this wait:
   a. Confirm OpenChrome MCP server process is still alive (check `MCPClient.isRunning` every 10,000 ms).
   b. Issue one `navigate` call every `scaled(30_000)` ms. Each call is expected to fail (return an error), but must **not hang** — it must return within 10,000 ms (absolute, not scaled).
5. After the wait, record `t_relaunch`. Restart Chrome externally (e.g., via `ChromeController.waitForRelaunch()` or by spawning a new Chrome process on the same debug port).
6. Poll: attempt `navigate` tool calls with a 10,000 ms per-call timeout, every 2,000 ms, until one succeeds.
7. Record `t_recovered` when the first successful `navigate` returns.
8. Confirm `read_page` succeeds on the returned `tabId`.
9. Confirm `cookies` set/get works on the recovered tab.

#### Pass Criteria

| Criterion | Threshold | Measurement |
|-----------|-----------|-------------|
| MCP server survives Chrome absence | Alive at every 10 s poll during step 4 | `MCPClient.isRunning` |
| No hangs during Chrome absence | Every `navigate` in step 4b returns within 10,000 ms (error acceptable) | Per-call timeout |
| Reconnect after Chrome return | `t_recovered - t_relaunch` < 30,000 ms | Wall clock |
| `navigate` post-reconnect | Returns success | JSON-RPC result |
| `read_page` post-reconnect | Returns non-empty text | Response content |
| Cookie set/get post-reconnect | Cookie name present in `get` response | Response content |

#### Fail Criteria

- MCP server process exits during Chrome absence.
- Any `navigate` call in step 4b hangs (no response within 10,000 ms).
- `t_recovered - t_relaunch ≥ 30,000 ms`.
- `cookies` round-trip fails after reconnect.

#### Timeout

Full-scale: `scaled(7 * 60 * 1000) + JEST_OVERHEAD_MS` = 420,000 ms + 30,000 ms = **450,000 ms**.

#### CI Strategy

Push/PR with TIME_SCALE=0.167. The 5-minute wait compresses to ~50 s. Absolute hang detection threshold (10,000 ms per call) is not scaled.

---

### E2E-13: HTTP Transport Independence

**Category:** Server Independence

**Purpose:** Verify that when OpenChrome operates in HTTP transport mode, the server and Chrome state survive the death of a connected client, and a second independent client can connect and operate on the same Chrome state.

#### Preconditions

1. OpenChrome is started in HTTP mode (e.g., `node dist/index.js serve --http --port 3100 --auto-launch`).
2. Two independent `MCPClient` instances are available: `clientA` and `clientB`, each configured to connect via HTTP (not stdio).
3. Chrome is running with at least one navigated tab.

#### Steps

1. Connect `clientA`. Issue `navigate` to `http://localhost:{fixture-port}/site-a`. Record `tabId_A` and the page title from `read_page`.
2. Set a cookie via `clientA`: name=`client_a_marker`, value=`present`, path=`/`.
3. Verify `clientA` can read the cookie: `cookies` action=`get` returns `client_a_marker`.
4. List tabs via `clientA`: record the count and all `tabId` values. Confirm `tabId_A` is in the list.
5. Kill `clientA`'s TCP connection. Methods in priority order:
   - Call `clientA.stop()` to close the stdio/HTTP connection cleanly, then immediately destroy the underlying socket if HTTP.
   - If harness does not support socket-level kill, terminate `clientA` with `SIGKILL`.
6. Confirm OpenChrome HTTP server is still alive: send an HTTP `GET /health` or equivalent probe. It must respond within 3,000 ms.
7. Wait 2,000 ms.
8. Connect `clientB` (fresh `MCPClient` instance). Issue `navigate` to `http://localhost:{fixture-port}/site-b`. Confirm success.
9. List tabs via `clientB`. Confirm the tab count is ≥ the count recorded in step 4 (Chrome state preserved; `tabId_A` tab may still exist or may have been cleaned up — server must not crash either way).
10. Read cookie via `clientB` on the URL from step 1: `navigate` to `/site-a`, then `cookies` action=`get`. Confirm `client_a_marker` is present.
11. Issue 5 consecutive `navigate` + `read_page` pairs via `clientB`. All must succeed.

#### Pass Criteria

| Criterion | Threshold | Measurement |
|-----------|-----------|-------------|
| Server survives client A death | HTTP health probe returns 200 within 3,000 ms | Step 6 |
| Client B connects successfully | `navigate` in step 8 returns success | JSON-RPC result |
| Chrome state preserved | `client_a_marker` cookie readable by `clientB` | Step 10 |
| Tab state preserved | Tab count via `clientB` ≥ count in step 4 | Step 9 |
| No cross-client contamination | `clientB` responses contain only `clientB` request IDs | JSON-RPC `id` field |
| Functional continuity | All 5 `navigate`+`read_page` pairs in step 11 succeed | Step 11 |
| Zero hangs | Every tool call returns within 30,000 ms | Per-call timeout |

#### Fail Criteria

- HTTP server does not respond to health probe within 3,000 ms after client A death.
- `clientB` cannot connect or its first `navigate` fails.
- Cookie `client_a_marker` is absent when read by `clientB`.
- Any tool call hangs (no response within 30,000 ms).
- JSON-RPC response `id` fields are swapped between clients.

#### Timeout

Full-scale: `scaled(120_000) + JEST_OVERHEAD_MS` = 120,000 ms + 30,000 ms = **150,000 ms**.

#### CI Strategy

Push/PR with TIME_SCALE=0.167. No time-compressed waits; all steps are sequential and use absolute timeouts. HTTP mode must be enabled in the CI server configuration for this test.

---

### E2E-14: Multi-Client HTTP Concurrency

**Category:** Concurrent Operations

**Purpose:** Verify that 3 simultaneous HTTP clients making concurrent tool calls receive correct, uncontaminated responses, with no response mixing between clients.

#### Preconditions

1. OpenChrome is running in HTTP transport mode.
2. Three independent `MCPClient` instances (`clientA`, `clientB`, `clientC`) are instantiated.
3. Three distinct fixture URLs are prepared: `/site-a`, `/site-b`, `/site-c`.

#### Steps

1. Connect all three clients sequentially (not concurrently) and confirm each can issue a single `navigate` successfully.
2. Issue 10 concurrent `navigate` calls, distributed as follows:
   - `clientA`: 4 calls to `/site-a`.
   - `clientB`: 3 calls to `/site-b`.
   - `clientC`: 3 calls to `/site-c`.
   - All 10 calls are dispatched simultaneously using `Promise.all()`.
3. Collect all 10 responses. For each response, verify the returned URL or page title matches the URL requested by that client (i.e., no client receives the response meant for another client).
4. Verify each response carries the correct JSON-RPC `id` matching the request that originated it.
5. Issue a second round: 10 concurrent `read_page` calls, each using a `tabId` returned from step 2.
6. Collect all 10 `read_page` responses. Each must contain non-empty text.
7. Verify no response contains content from a URL that the originating client did not request.

#### Pass Criteria

| Criterion | Threshold | Measurement |
|-----------|-----------|-------------|
| All 10 `navigate` calls complete | 10 of 10 return a response (success or error; no hangs) | `Promise.all` resolution |
| Zero cross-client contamination (navigate) | Each of the 10 responses matches the URL requested by that client | URL/title check per response |
| Correct JSON-RPC ID routing | Each response `id` matches its originating request `id` | Per-response assertion |
| All 10 `read_page` calls complete | 10 of 10 return non-empty text | `Promise.all` resolution |
| Zero cross-client contamination (read_page) | No response contains content from a URL not requested by that client | Content inspection |
| Zero errors | 0 of 10 `navigate` calls return a JSON-RPC error | Error field check |
| Zero hangs | All 20 calls return within 60,000 ms total | `Promise.all` timeout |

#### Fail Criteria

- Any of the 10 `navigate` calls hangs (no response within 60,000 ms).
- Any response `id` is mismatched to its request.
- Any `read_page` response contains content from a URL not navigated by that client.
- More than 0 `navigate` calls return a JSON-RPC error.

#### Timeout

Full-scale: `scaled(90_000) + JEST_OVERHEAD_MS` = 90,000 ms + 30,000 ms = **120,000 ms**.

#### CI Strategy

Push/PR with TIME_SCALE=0.167. All timeouts are absolute (not scaled). Requires HTTP mode in CI.

---

### E2E-15: Parallel Tool Call Burst

**Category:** Concurrent Operations

**Purpose:** Verify that OpenChrome handles a burst of 10 simultaneous tool calls dispatched at the exact same instant without hanging, losing any response, or crashing.

#### Preconditions

1. OpenChrome MCP server is running in stdio mode.
2. Chrome is connected and a base navigation has succeeded.
3. Three fixture URLs are available: `/`, `/site-a`, `/site-b`.

#### Steps

1. Construct 10 `navigate` calls targeting the following URLs (cycled):
   - Calls 0, 3, 6, 9: `http://localhost:{fixture-port}/`
   - Calls 1, 4, 7: `http://localhost:{fixture-port}/site-a`
   - Calls 2, 5, 8: `http://localhost:{fixture-port}/site-b`
2. Record `t_burst_start = Date.now()`.
3. Dispatch all 10 calls simultaneously using a single `Promise.all()`. Each call has an individual timeout of 60,000 ms.
4. `Promise.all()` must resolve (not reject due to timeout) within 120,000 ms.
5. Record `t_burst_end = Date.now()` when `Promise.all()` settles.
6. Count the number of responses that are successes vs. errors vs. timeouts.
7. For each response, confirm the response object is a valid JSON-RPC response (has `jsonrpc`, `id`, and either `result` or `error`).
8. Issue a `navigate` call immediately after the burst completes. It must succeed within 30,000 ms, confirming the server is not in a degraded state.

#### Pass Criteria

| Criterion | Threshold | Measurement |
|-----------|-----------|-------------|
| All 10 calls return a response | 10 of 10 responses received (success or error) | `Promise.all` settles |
| Zero hangs | 0 calls time out (timeout = 60,000 ms per call) | Per-call timeout |
| Total burst time | `t_burst_end - t_burst_start` < 120,000 ms | Wall clock |
| Valid JSON-RPC format | All 10 responses have `jsonrpc`, `id`, and `result` or `error` | Per-response assertion |
| Post-burst health | `navigate` after burst succeeds within 30,000 ms | Step 8 |

#### Fail Criteria

- Any of the 10 calls does not return a response within 60,000 ms (this is a hang by definition).
- `t_burst_end - t_burst_start ≥ 120,000 ms`.
- Post-burst `navigate` fails or hangs.
- Any response is malformed (missing `id` or both `result` and `error`).

#### Timeout

Full-scale: `scaled(180_000) + JEST_OVERHEAD_MS` = 180,000 ms + 30,000 ms = **210,000 ms**.

#### CI Strategy

Push/PR with TIME_SCALE=0.167. All absolute timeout values (60,000 ms per call, 120,000 ms total) are not scaled — they are wall-clock guarantees.

---

### E2E-16: Rate Limiter Under Flood

**Category:** Overload Protection

**Purpose:** Verify that when OpenChrome is configured with a rate limit, a flood of requests above the limit receives graceful rejections (not hangs, not crashes), the server survives the flood, and responses include retry guidance.

#### Preconditions

1. OpenChrome MCP server is started with rate limiting configured at 10 requests per 60-second window (or equivalent config flag that produces this limit).
2. The rate limiter configuration is applied to tool call dispatch, not the HTTP layer (this test applies to both stdio and HTTP modes; stdio mode should apply rate limiting at the tool router level).
3. Chrome is connected and operational.

#### Steps

1. Confirm rate limiter is active: issue 3 sequential `navigate` calls and verify they succeed. Record these as part of the initial budget.
2. Record `t_flood_start = Date.now()`.
3. Dispatch 30 `navigate` calls simultaneously using `Promise.all()`. Each call has an individual timeout of 30,000 ms.
4. Wait for `Promise.all()` to settle. Record `t_flood_end = Date.now()`.
5. Categorize each of the 30 responses:
   - **Success**: JSON-RPC `result` present, no `error`.
   - **Graceful rejection**: JSON-RPC `error` present with a non-zero error code.
   - **Hang**: No response within 30,000 ms.
6. For each graceful rejection, inspect the error message or metadata for retry guidance. Acceptable forms: error message contains the string `retry`, or a `retryAfterMs` field is present in the error data, or an HTTP `Retry-After` header is present (HTTP mode only).
7. Confirm the server is still alive after the flood: issue a `navigate` call with a 10,000 ms timeout. It must succeed within the remaining rate-limit window, or within 65,000 ms if the window resets.
8. Confirm Chrome is still connected: `read_page` on a known `tabId` must succeed.

#### Pass Criteria

| Criterion | Threshold | Measurement |
|-----------|-----------|-------------|
| Zero hangs | 0 of 30 calls time out (timeout = 30,000 ms per call) | Per-call timeout |
| Successes + rejections = 30 | All 30 calls receive a response | Response count |
| Success count | ≥ 10 and ≤ 20 (some may succeed depending on timing) | Success category count |
| Graceful rejection count | ≥ 10 (remaining calls beyond rate limit must be rejected, not hung) | Rejection category count |
| Retry guidance present | ≥ 90% of graceful rejections include retry guidance | Per-rejection inspection |
| Server alive post-flood | Post-flood `navigate` returns success within 65,000 ms | Step 7 |
| Chrome connected post-flood | `read_page` returns non-empty text | Step 8 |
| Total flood duration | `t_flood_end - t_flood_start` < 35,000 ms | Wall clock |

#### Fail Criteria

- Any call hangs (no response within 30,000 ms).
- The server process exits during or after the flood.
- Chrome disconnects and does not automatically reconnect within 30,000 ms.
- More than 20 calls return a JSON-RPC error (would mean fewer than 10 succeeded, violating the rate limit's own guarantee).
- Zero calls include retry guidance in their rejection error.

#### Timeout

Full-scale: `scaled(120_000) + JEST_OVERHEAD_MS` = 120,000 ms + 30,000 ms = **150,000 ms**.

#### CI Strategy

Push/PR with TIME_SCALE=0.167. Rate limiter window (60 s) is not compressed — it is a real wall-clock window. The test must tolerate the full window before verifying post-flood health in step 7.

---

### E2E-17: Prometheus Metrics Accuracy

**Category:** Observability

**Purpose:** Verify that OpenChrome's Prometheus `/metrics` endpoint reports counters that exactly match the number of tool calls executed and their outcomes.

#### Preconditions

1. OpenChrome is started with Prometheus metrics enabled and the `/metrics` endpoint exposed on a known port (default: same port as HTTP transport, or a dedicated metrics port).
2. The metrics counters start at 0 (server is freshly started for this test).
3. The `HeapSampler` has taken a baseline RSS reading before any tool calls.

#### Steps

1. Scrape `/metrics` before any tool calls. Record baseline values for `tool_calls_total`, `tool_calls_success`, `tool_calls_error`, and `process_resident_memory_bytes` (or equivalent heap gauge). Confirm all counters are 0.
2. Issue exactly **5 successful `navigate` calls** to distinct fixture URLs:
   - Call 1: `navigate` to `/`
   - Call 2: `navigate` to `/site-a`
   - Call 3: `navigate` to `/site-b`
   - Call 4: `navigate` to `/site-c`
   - Call 5: `navigate` to `/login`
   All 5 must succeed (return a valid `tabId` in the response).
3. Issue exactly **2 calls that must produce tool-level errors**. Use a method that reliably produces a tool error without causing a hang:
   - Call 6: `read_page` with `tabId` = `"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"` (a non-existent tab ID of valid format). This must return a JSON-RPC error, not a hang.
   - Call 7: `navigate` with `url` = `"not-a-valid-url"` (malformed URL). This must return a JSON-RPC error, not a hang.
4. Wait 1,000 ms for metrics to be flushed (Prometheus metrics in the Node.js process are synchronous; this wait accounts for any async batching).
5. Scrape `/metrics`. Parse the response using the Prometheus text exposition format.
6. Extract values for:
   - `tool_calls_total` (or `openchrome_tool_calls_total`)
   - `tool_calls_success` (or `openchrome_tool_calls_success_total`)
   - `tool_calls_error` (or `openchrome_tool_calls_error_total`)
   - `process_resident_memory_bytes` (or `openchrome_heap_bytes`)
7. Compare extracted values against expected values from steps 2 and 3.
8. Compare heap gauge to actual RSS from `HeapSampler.getDelta()`.

#### Pass Criteria

| Criterion | Threshold | Measurement |
|-----------|-----------|-------------|
| `tool_calls_total` | == 7 | Exact equality |
| `tool_calls_success` | == 5 | Exact equality |
| `tool_calls_error` | == 2 | Exact equality |
| Heap gauge accuracy | Within ±10% of actual RSS from `HeapSampler` | Relative error |
| Metrics endpoint reachable | HTTP 200 within 3,000 ms | HTTP response status |
| Both error calls return errors (not hangs) | Calls 6 and 7 return JSON-RPC errors within 10,000 ms | Per-call timeout |

#### Fail Criteria

- `tool_calls_total` ≠ 7.
- `tool_calls_success` ≠ 5.
- `tool_calls_error` ≠ 2.
- Heap gauge deviates from actual RSS by more than 10%.
- `/metrics` endpoint does not return HTTP 200 within 3,000 ms.
- Call 6 or call 7 hangs (no response within 10,000 ms).

#### Timeout

Full-scale: `scaled(60_000) + JEST_OVERHEAD_MS` = 60,000 ms + 30,000 ms = **90,000 ms**.

#### CI Strategy

Push/PR with TIME_SCALE=0.167. This test does not use time-compressed waits. Requires Prometheus metrics to be compiled in and the `/metrics` endpoint to be reachable in the CI environment.

---

### E2E-18: Disk Space Auto-Cleanup

**Category:** Resource Safety

**Purpose:** Verify that when the number of journal/snapshot files exceeds the configured limit, OpenChrome automatically prunes old entries without interrupting ongoing tool operations.

#### Preconditions

1. OpenChrome MCP server is running with session state persistence enabled.
2. The cleanup threshold is set to a small number suitable for testing (e.g., maximum 10 journal files, maximum 10 snapshot files — configurable via environment variable `E2E_CLEANUP_MAX_FILES=10` or equivalent).
3. The journal/snapshot directory is known (e.g., from `SessionStatePersistence.getFilePath()` parent directory).

#### Steps

1. Record the journal/snapshot directory path. Confirm it exists and is writable.
2. Generate **110 synthetic journal files** in the directory by writing minimal valid journal content to files named `journal-{timestamp}-{n}.json` for n = 0..109. Use timestamps spaced 1,000 ms apart so the file-age ordering is deterministic. The 100 oldest files must have timestamps more than 1 hour old; the 10 newest must have timestamps within the last 60 s.
3. Confirm 110 files are present (≥ 100 files triggers cleanup; exact count must be ≥ 110 before triggering).
4. Trigger cleanup: call the cleanup API (e.g., `mcp.callTool('oc_cleanup', { target: 'journals' })`, or the equivalent internal method). If no explicit cleanup tool exists, wait for the scheduled cleanup cycle to fire (the cycle interval must be ≤ 60,000 ms at full scale; at CI scale this is ≤ `scaled(60_000)` ms).
5. While cleanup is in progress (or immediately after triggering), issue 5 sequential `navigate` + `read_page` pairs to verify tool operations are unaffected.
6. Wait for cleanup to complete: poll the file count every 1,000 ms until it drops below 15, or until 30,000 ms elapses.
7. Count remaining files. Verify the count is ≤ the configured maximum (10 in the precondition).
8. Verify the 10 newest files (by timestamp) are among the survivors (recent entries are preserved).
9. Verify the 100 oldest synthetic files are deleted.

#### Pass Criteria

| Criterion | Threshold | Measurement |
|-----------|-----------|-------------|
| File count after cleanup | ≤ configured maximum (10 in precondition) | File system count |
| Recent files preserved | The 10 newest synthetic files still present | File existence check |
| Old files deleted | ≥ 100 synthetic files with old timestamps deleted | File absence check |
| Zero tool failures during cleanup | All 5 `navigate`+`read_page` pairs in step 5 succeed | Step 5 |
| Cleanup completion time | File count drops to ≤ max within 30,000 ms of triggering | Wall clock |

#### Fail Criteria

- File count remains ≥ 15 for more than 30,000 ms after cleanup is triggered.
- Any of the 5 tool calls in step 5 fails or hangs.
- Any of the 10 newest files is absent after cleanup (recent data loss).
- The MCP server exits during cleanup.

#### Timeout

Full-scale: `scaled(120_000) + JEST_OVERHEAD_MS` = 120,000 ms + 30,000 ms = **150,000 ms**.

#### CI Strategy

Push/PR with TIME_SCALE=0.167. The cleanup cycle interval must scale with `TIME_SCALE`; the 30,000 ms wait in step 6 is absolute (wall clock).

---

### E2E-19: Event Loop Fatal Recovery

**Category:** Resource Safety

**Purpose:** Verify the full Layer 4 watchdog recovery sequence: when the event loop is blocked beyond the fatal threshold, the MCP server process exits with a non-zero code, Chrome survives as a detached process, and a supervisor can restart the MCP server to restore full functionality.

#### Preconditions

1. OpenChrome MCP server is started with the event loop monitor configured with `fatalThresholdMs = 5,000` ms (for test purposes; production default is 30,000 ms). Use environment variable `E2E_FATAL_THRESHOLD_MS=5000` or equivalent.
2. `ChromeController` has discovered the Chrome PID before the fault is induced.
3. A mechanism exists to inject a ≥ 6,000 ms synchronous block into the MCP server's event loop without killing the process externally. Acceptable mechanisms:
   - A dedicated test-only tool `oc_block_event_loop` that calls `Atomics.wait()` or a spin loop for a configurable duration.
   - A Unix signal handler that blocks on receipt of `SIGUSR1`.
4. Chrome is launched with `--remote-debugging-port` in `--remote-allow-origins=*` mode so it persists after the MCP server process exits.

#### Steps

1. Navigate to `http://localhost:{fixture-port}/site-a` and confirm success. Record Chrome PID via `ChromeController.discoverPid()`. Record `chromePid`.
2. Record `t_block_start = Date.now()`.
3. Issue the event loop block: call `mcp.callTool('oc_block_event_loop', { durationMs: 6000 }, 60_000)`. This call will not return a response because the server process will exit. The call is expected to result in a harness-level error (process closed stdin/stdout) or a timeout — both are acceptable outcomes for this call.
4. Poll `MCPClient.isRunning` every 200 ms until it returns `false`, or until 10,000 ms elapses from `t_block_start`.
5. Record `t_exited = Date.now()` when `MCPClient.isRunning` first returns `false`.
6. Confirm the server process exited with a non-zero exit code. If `ChildProcess.exitCode` is not directly observable, confirm it is not `0` and not `null` (null means process was killed by signal, which also counts as non-zero for this criterion).
7. Confirm Chrome is still alive: `ChromeController.isRunning()` must return `true`. `chromePid` must still be the active PID.
8. Record `t_restart_start = Date.now()`. Start a new `MCPClient` instance (simulating supervisor restart). Call `mcp.start()`.
9. Record `t_restart_done` when `mcp.start()` resolves.
10. Issue `navigate` to `http://localhost:{fixture-port}/` on the new server instance. It must succeed within 30,000 ms.
11. Confirm `read_page` on the returned `tabId` returns non-empty text.

#### Pass Criteria

| Criterion | Threshold | Measurement |
|-----------|-----------|-------------|
| Process exits | `MCPClient.isRunning` returns `false` within `fatalThresholdMs + 2,000` ms of `t_block_start` | That is, within 7,000 ms of inducing the block |
| Exit code non-zero | Exit code ≠ 0 | `ChildProcess.exitCode` or signal exit |
| Chrome survives | `ChromeController.isRunning()` returns `true` after server exit | Step 7 |
| Chrome PID unchanged | PID after exit == `chromePid` recorded in step 1 | Step 7 |
| Restart succeeds | `mcp.start()` resolves within 30,000 ms | `t_restart_done - t_restart_start` |
| Post-restart `navigate` | Succeeds within 30,000 ms | Step 10 |
| Post-restart `read_page` | Returns non-empty text | Step 11 |

#### Fail Criteria

- MCP server process does not exit within 7,000 ms of inducing the block.
- MCP server exits with code `0` (clean exit is not acceptable; fatal exit must be non-zero).
- Chrome process dies when the MCP server exits.
- Chrome PID changes between step 1 and step 7 (Chrome was restarted, not merely surviving).
- `mcp.start()` fails or times out.
- `navigate` after restart fails or hangs.

#### Timeout

Full-scale: `scaled(120_000) + JEST_OVERHEAD_MS` = 120,000 ms + 30,000 ms = **150,000 ms**.

#### CI Strategy

Push/PR with TIME_SCALE=0.167. The fatal threshold (5,000 ms) and the process-exit detection window (7,000 ms) are absolute wall-clock values, not compressed. Requires the `oc_block_event_loop` test-only tool to be compiled into the CI build or available via a test-mode flag.

---

### E2E-20: 72-Hour Endurance (Nightly)

**Category:** Connection Resilience (composite)

**Purpose:** Verify long-term operational stability under continuous load with periodic fault injection across all three fault dimensions: Chrome crash, MCP server restart, and network disconnection.

#### Preconditions

1. OpenChrome MCP server is running with `--auto-launch` and all watchdog layers enabled.
2. `OPENCHROME_ENDURANCE=1` and `ENDURANCE_HOURS=72` environment variables are set.
3. `TIME_SCALE=1.0` (no compression; this is a nightly test only).
4. Prometheus `/metrics` endpoint is exposed for health sampling.
5. An external process (e.g., supervisord, PM2) is configured to restart the MCP server within 5,000 ms of process exit. For the test, this is simulated by the harness via `MCPClient.restart()`.
6. `ChromeController` is configured with debug port `19333` (isolated port).

#### Steps

1. Take baseline heap measurement. Record `t_start = Date.now()`. Set `t_end = t_start + 72 * 60 * 60 * 1000`.
2. Run the main endurance loop until `Date.now() >= t_end`:

   **Every 60 minutes:**
   - Kill Chrome via `ChromeController.kill('SIGKILL')`.
   - Confirm Chrome is dead within 3,000 ms.
   - Wait up to 30,000 ms for auto-relaunch (auto-launch watchdog).
   - Verify recovery by issuing `navigate`. Record recovery time.
   - Recovery time must be < 30,000 ms. If ≥ 30,000 ms, record as a recovery failure.

   **Every 4 hours:**
   - Call `MCPClient.restart()`.
   - Confirm server restarts within 30,000 ms.
   - Issue `navigate` + `read_page` to verify operational.

   **Every 12 hours:**
   - Simulate network disconnection: block CDP traffic for `scaled(2 * 60 * 1000)` ms (2 minutes full-scale) using OS-level firewall rules or socket close.
   - Confirm OpenChrome detects disconnect within 2 heartbeat cycles.
   - Remove the block. Verify reconnect within 15,000 ms.

   **Continuous (every 5,000 ms during active phases):**
   - Cycle through `navigate` + `read_page` on `/`, `/site-a`, `/site-b`, `/site-c`.
   - Record each call as success or failure.

3. Every 5 minutes, sample heap RSS and scrape Prometheus metrics.
4. At `t_end`, compute final metrics.

#### Pass Criteria

| Criterion | Threshold | Measurement |
|-----------|-----------|-------------|
| Overall success rate | ≥ 99.0% | `successes / total_operations` |
| Chrome recovery time (per event) | < 30,000 ms for every individual recovery | Per-recovery wall clock |
| Chrome recovery time (average over all events) | < 15,000 ms | Average of all recovery times |
| MCP server restart time | < 30,000 ms per restart | Per-restart wall clock |
| Network reconnect time | < 15,000 ms per event (after block removed) | Per-event wall clock |
| Heap growth over 72 h | < 300 MB (RSS delta from baseline to final sample) | `HeapSampler.getDelta()` |
| Zero hangs | 0 tool calls time out (timeout = 60,000 ms per call) | Per-call timeout |
| Prometheus counters consistent | `tool_calls_total` at end matches `successes + failures` recorded by harness (±1%) | Counter comparison |

#### Fail Criteria

- Success rate drops below 99.0%.
- Any individual Chrome recovery takes ≥ 30,000 ms.
- Average Chrome recovery time ≥ 15,000 ms.
- Any tool call hangs (no response within 60,000 ms).
- Heap growth ≥ 300 MB from baseline.
- MCP server process exits unexpectedly (outside of scheduled restarts).

#### Timeout

Full-scale only: `72 * 60 * 60 * 1000 + JEST_OVERHEAD_MS` = **259,230,000 ms** (≈ 72 h 0.5 min).

#### CI Strategy

**Nightly only.** Never runs on push/PR. Activated by CI schedule with `OPENCHROME_ENDURANCE=1 ENDURANCE_HOURS=72 TIME_SCALE=1.0`. Results are posted as a GitHub check with pass/fail status. A failure blocks the next release candidate promotion but does not block PR merges.

---

### E2E-21: Graceful Degradation Under System Pressure

**Category:** Resource Safety

**Purpose:** Verify that when the Node.js heap approaches capacity, OpenChrome triggers aggressive session cleanup, maintains tool call availability (possibly at reduced speed), and stabilizes memory without crashing.

#### Preconditions

1. OpenChrome MCP server is running with the memory pressure threshold set to trigger aggressive cleanup at 80% of `--max-old-space-size`. For testing, set `--max-old-space-size=256` (256 MB limit) so 80% = 204 MB is reachable without exhausting system memory.
2. The aggressive cleanup TTL under pressure is configured at 5 minutes (300,000 ms) via `E2E_PRESSURE_TTL_MS=300000` or equivalent. Normal TTL is 30 minutes.
3. A mechanism exists to fill the heap to approximately 80% of the limit. Acceptable approaches:
   - A test-only tool `oc_fill_heap` that allocates a configurable number of bytes and holds them in a module-level buffer.
   - Allocating large string buffers directly in the test process shared with the server (not applicable for stdio; use the tool approach).
4. `HeapSampler` has taken a baseline reading.

#### Steps

1. Confirm baseline heap is below 40% of the limit (< 102 MB for the 256 MB configuration) by reading `process.memoryUsage().heapUsed` via a test-only diagnostic tool or by `HeapSampler` measurement.
2. Issue a `navigate` + `read_page` pair. Record the round-trip latency as `baseline_latency_ms`.
3. Trigger heap fill: call `mcp.callTool('oc_fill_heap', { targetBytes: 163_840_000 })` (160 MB, approximately 80% of 256 MB - 96 MB for existing allocations = fills to ~80%). The call must return within 10,000 ms.
4. Confirm heap is above the pressure threshold: read `process.memoryUsage().heapUsed` and verify it is ≥ 200 MB. If it is below 200 MB, the fill tool did not work and the test must be aborted with an explicit error (not a pass).
5. Verify aggressive cleanup triggers within 60,000 ms:
   - The session TTL is reduced to 300,000 ms (5 minutes).
   - Any sessions older than 5 minutes are evicted.
   - Observable evidence: a log message containing `memory pressure`, `aggressive cleanup`, or `evicted` (exact string depends on implementation), or a reduction in the `openchrome_active_sessions` Prometheus gauge.
6. While cleanup is active (or immediately after triggering), issue 10 sequential `navigate` + `read_page` pairs. All 10 must succeed. Record all 10 round-trip latencies.
7. After all 10 pairs complete, measure heap via `HeapSampler.getDelta()`.
8. Wait 10,000 ms, then issue one final `navigate` + `read_page`. It must succeed.

#### Pass Criteria

| Criterion | Threshold | Measurement |
|-----------|-----------|-------------|
| Zero tool failures | All 10 pairs in step 6 succeed (0 errors) | Step 6 |
| Zero hangs | All tool calls return within 60,000 ms each | Per-call timeout |
| Cleanup triggered | Evidence of cleanup within 60,000 ms of heap fill | Step 5 |
| Heap stabilized | Heap delta from post-fill to end ≤ 0 MB (must not grow further) | `HeapSampler` final sample |
| Latency degradation acceptable | p95 of 10 latencies in step 6 < 5 × `baseline_latency_ms` | Relative latency check |
| Final health check passes | `navigate` + `read_page` in step 8 succeed | Step 8 |

#### Fail Criteria

- Any tool call in step 6 fails (returns JSON-RPC error).
- Any tool call hangs (no response within 60,000 ms).
- No evidence of cleanup within 60,000 ms of heap fill reaching threshold.
- Heap continues to grow after cleanup triggers (delta > 0 MB from post-fill baseline after cleanup).
- MCP server exits (crash) during or after heap fill.

#### Timeout

Full-scale: `scaled(300_000) + JEST_OVERHEAD_MS` = 300,000 ms + 30,000 ms = **330,000 ms**.

#### CI Strategy

Push/PR with TIME_SCALE=0.167. The heap fill sizes (bytes) and the cleanup TTL (300,000 ms) are absolute values, not compressed. The 60,000 ms cleanup detection window is absolute. Requires `--max-old-space-size=256` in the CI Node.js invocation for this test.

---

## 5. Certification Matrix

The following table is the authoritative reference for all 21 certification tests.

| ID | Title | Category | Status | CI Track | Required for Certification | Phase Dependency |
|----|-------|----------|--------|----------|---------------------------|-----------------|
| E2E-1 | Marathon (60 min continuous) | Connection Resilience | Existing ✅ | Push/PR, Nightly | Yes | Phase 0 (shipped) |
| E2E-2 | Chrome Kill -9 Recovery | Connection Resilience | Existing ✅ | Push/PR, Nightly | Yes | Phase 0 (shipped) |
| E2E-3 | MCP Server Restart | Server Independence | Existing ✅ | Push/PR, Nightly | Yes | Phase 0 (shipped) |
| E2E-4 | Auth Persistence | Connection Resilience | Existing ✅ | Push/PR, Nightly | Yes | Phase 0 (shipped) |
| E2E-5 | Tab Isolation | Concurrent Operations | Existing ✅ | Push/PR, Nightly | Yes | Phase 0 (shipped) |
| E2E-6 | Memory Stability / Pressure | Resource Safety | Existing ✅ | Push/PR, Nightly | Yes | Phase 0 (shipped) |
| E2E-7 | Idle Session / Multi-site | Connection Resilience | Existing ✅ | Push/PR, Nightly | Yes | Phase 0 (shipped) |
| E2E-8 | 24 h Endurance / Compaction Resume | Connection Resilience | Existing ✅ | Nightly | Yes | Phase 0 (shipped) |
| E2E-9 | Multi-profile | Concurrent Operations | Existing ✅ | Push/PR, Nightly | Yes | Phase 0 (shipped) |
| E2E-10 | Multi-profile Errors | Concurrent Operations | Existing ✅ | Push/PR, Nightly | Yes | Phase 0 (shipped) |
| E2E-11 | WebSocket Disconnect Without Process Death | Connection Resilience | New ❌ | Push/PR, Nightly | Yes | Phase 1: Heartbeat & reconnect |
| E2E-12 | Infinite Reconnection (Chrome Down 5 min) | Connection Resilience | New ❌ | Push/PR, Nightly | Yes | Phase 1: Heartbeat & reconnect |
| E2E-13 | HTTP Transport Independence | Server Independence | New ❌ | Push/PR, Nightly | Yes | Phase 2: HTTP transport |
| E2E-14 | Multi-Client HTTP Concurrency | Concurrent Operations | New ❌ | Push/PR, Nightly | Yes | Phase 2: HTTP transport |
| E2E-15 | Parallel Tool Call Burst | Concurrent Operations | New ❌ | Push/PR, Nightly | Yes | Phase 1: Concurrent dispatch |
| E2E-16 | Rate Limiter Under Flood | Overload Protection | New ❌ | Push/PR, Nightly | Yes | Phase 3: Rate limiter |
| E2E-17 | Prometheus Metrics Accuracy | Observability | New ❌ | Push/PR, Nightly | Yes | Phase 3: Observability |
| E2E-18 | Disk Space Auto-Cleanup | Resource Safety | New ❌ | Push/PR, Nightly | Yes | Phase 2: Cleanup system |
| E2E-19 | Event Loop Fatal Recovery | Resource Safety | New ❌ | Push/PR, Nightly | Yes | Phase 1: Watchdog (Layer 4) |
| E2E-20 | 72-Hour Endurance (Nightly) | Connection Resilience (composite) | New ❌ | Nightly (Weekly for full 72 h) | Yes | Phase 4: All phases complete |
| E2E-21 | Graceful Degradation Under System Pressure | Resource Safety | New ❌ | Push/PR, Nightly | Yes | Phase 3: Memory pressure handler |

### CI Track Definitions

| Track | Trigger | TIME_SCALE | Tests Included |
|-------|---------|------------|----------------|
| Push/PR | Every commit and pull request | `0.167` | E2E-1 through E2E-19, E2E-21 |
| Nightly | Scheduled daily at 02:00 UTC | `1.0` | All 21 tests (full scale) |
| Weekly | Scheduled weekly (Sunday 00:00 UTC) | `1.0` | E2E-20 only (72 h) |

---

## 6. Certification Rules

### 6.1 "Reliability Certified" Badge

OpenChrome may display the **"Reliability Certified"** badge in its README and release notes if and only if ALL of the following conditions are simultaneously true:

1. Every test marked **Required for Certification = Yes** in the certification matrix passes on the most recent nightly run.
2. The nightly run was executed with `TIME_SCALE=1.0` (no compression).
3. No test was skipped, marked pending, or had its pass criteria modified within the 30 days preceding the certification claim.
4. The passing nightly run was executed against the exact commit SHA that is tagged for release.

Failure of any single required test invalidates the badge for that release, regardless of how many other tests pass.

### 6.2 Nightly CI Requirements

The nightly CI pipeline must:

1. Run the full suite of all 21 E2E tests with `TIME_SCALE=1.0`.
2. Post results as GitHub commit status checks against the `develop` branch HEAD.
3. Emit a Slack/PagerDuty alert within 5 minutes of the first test failure.
4. Retain test result artifacts (logs, metrics, heap samples) for a minimum of 30 days.
5. Never suppress or auto-retry a failing test without manual approval from a maintainer. Flaky test suppression is not permitted; flaky tests must be fixed or removed from the suite.

### 6.3 Regression Policy

Any regression (a test that previously passed and now fails) is classified as **P0** and triggers the following response:

1. The failing test blocks all further merges to `develop` and `main` until the regression is resolved. CI must enforce this via branch protection rules.
2. The on-call engineer must acknowledge the alert within 30 minutes of the nightly failure notification.
3. A root cause must be identified within 24 hours of the regression being detected.
4. A fix must be merged within 72 hours, or an explicit revert of the regressing commit must be executed.
5. A P0 regression that is not acknowledged within 30 minutes or not fixed within 72 hours triggers escalation to the project lead.

### 6.4 Merge Gate for New Features

No pull request may be merged into `develop` if it causes any of the following:

1. Any certification test to transition from passing to failing (as measured by the Push/PR CI track).
2. Any certification test timeout to increase by more than 10% compared to the `develop` branch HEAD.
3. Any pass criterion to become unreachable (e.g., a refactor that removes the Prometheus metrics endpoint would automatically fail E2E-17).

The CI system must run the full Push/PR suite on every pull request and report results before merge is permitted.

### 6.5 Criteria Immutability

The pass criteria defined in this document are **immutable under normal development**. A change to any pass criterion (threshold number, metric definition, or category) requires:

1. A written justification filed as a GitHub issue.
2. Explicit approval from two maintainers (not including the author of the change).
3. A comment in this document recording the old value, new value, date, approving maintainers, and the GitHub issue number.
4. The change must not be retroactively applied to historical certification claims.

Acceptable reasons for criteria change include: hardware capability improvements that render old thresholds trivially achievable, discovery that a threshold was set based on incorrect assumptions, or an architectural change that makes a specific measurement method impossible while an equivalent alternative exists.

Unacceptable reasons include: a test is hard to pass, a feature was not implemented to spec, or CI is slow.

### 6.6 Test Immutability

The test implementations themselves are subject to the same immutability rules as the criteria above. Specifically:

1. A test's pass criteria may not be changed to match a broken implementation. The implementation must be fixed to match the criteria.
2. A test may not be disabled or marked `.skip` without the same two-maintainer approval process.
3. A test's timeout may be increased by up to 10% without approval if the increase is solely due to CI infrastructure slowness (documented with evidence). Any increase greater than 10% requires approval.
4. New tests may be added without approval, but existing tests may not be removed without the approval process.

---

*Document version: 1.0.0. Last updated: 2026-03-24.*
