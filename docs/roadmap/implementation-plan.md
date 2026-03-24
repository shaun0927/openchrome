# OpenChrome Reliability Guarantee — Implementation Plan

**Version**: 1.0
**Target branch**: `develop`
**Scope**: 7 phases covering daemon transport, infinite reconnection, rate limiting, production defaults, metrics, deployment infrastructure, and disk monitoring.

---

## Summary

This document provides phase-by-phase technical implementation details for the reliability guarantee initiative. The work transforms OpenChrome from a per-session stdio tool into a long-running daemon capable of serving multiple concurrent MCP clients over HTTP with production-grade resilience.

The phases are ordered by priority and dependency. Phases 1 and 2 are foundational and must ship together (HTTP transport is only useful paired with infinite reconnection). Phases 3–5 are independent enhancements that can be developed in parallel once Phase 1 is stable. Phases 6 and 7 are additive and carry no risk.

---

## Prerequisites

Before starting implementation, verify the following:

1. **MCP SDK version**: The `@modelcontextprotocol/sdk` package (or equivalent) must be at v1.10.0 or later to access `StreamableHTTPServerTransport`. Check `package.json` — as of v1.8.6 there is no MCP SDK listed as a dependency, meaning the server hand-rolls JSON-RPC over stdio (see `src/mcp-server.ts` line 5, `readline` import). Phase 1 must therefore either add the SDK or implement Streamable HTTP directly against the spec.

2. **Node.js**: v18+ required (already enforced in `package.json` `engines` field). Streamable HTTP uses standard `node:http` — no additional runtime requirements.

3. **Existing self-healing wiring**: The `src/index.ts` `serve` command already wires `ChromeProcessWatchdog`, `TabHealthMonitor`, `EventLoopMonitor`, `HealthEndpoint`, and `SessionStatePersistence`. All Phase 1 changes must preserve this wiring.

4. **stdout discipline**: `src/mcp-server.ts` line 335 uses `console.log()` to send JSON-RPC responses to stdout. In HTTP mode the response channel changes — the HTTP transport must write to the HTTP response body, not stdout. The `console.log()` call in `sendResponse()` must be gated on transport type.

5. **Test harness**: E2E tests use `tests/e2e/jest.e2e.config.js`. New E2E tests (E2E-12 through E2E-19) follow existing naming conventions in that directory.

---

## Phase 1: Streamable HTTP Transport

**Priority**: CRITICAL
**Estimated complexity**: Large
**Risk**: High — touches core protocol layer; regression on stdio breaks every existing user
**Depends on**: Nothing (Phase 1 is the foundation)
**Enables**: Phase 2 (HTTP mode needed for infinite reconnection default), Phase 6 (deployment configs reference `--http` flag)

### Goal

Add `openchrome serve --http <port>` daemon mode. The server accepts MCP JSON-RPC over HTTP (Streamable HTTP, MCP spec 2025-03-26) on a configurable port, while continuing to serve stdio clients unchanged.

### Technical Approach

The MCP spec 2025-03-26 defines Streamable HTTP as a single endpoint (typically `POST /mcp`) that accepts JSON-RPC request bodies and returns either a JSON response body or an SSE stream for streaming results. This replaces the older HTTP+SSE split-endpoint pattern.

The current `MCPServer` class (in `src/mcp-server.ts`) is tightly coupled to `readline` on stdin/stdout. The refactor introduces a `MCPTransport` interface that abstracts the message I/O layer. `MCPServer` becomes transport-agnostic: it receives parsed JSON-RPC objects, processes them, and hands responses back to the transport. The transport owns the wire format.

Because the server currently uses a hand-rolled JSON-RPC engine (no MCP SDK dependency), the HTTP transport will use `node:http` directly, implementing the Streamable HTTP framing without an SDK dependency. This keeps the dependency footprint minimal and avoids a breaking SDK upgrade.

### Files to Create

**`src/transports/index.ts`**
Transport factory and the `MCPTransport` interface. Exports `createTransport(mode, options)` which returns either `StdioTransport` or `HTTPTransport`.

```typescript
export interface MCPTransport {
  /** Register handler for incoming JSON-RPC messages. */
  onMessage(handler: (msg: Record<string, unknown>) => Promise<Record<string, unknown> | null>): void;
  /** Send a JSON-RPC response or notification. */
  send(response: Record<string, unknown>): void;
  /** Start listening (bind port or attach readline). */
  start(): void;
  /** Graceful shutdown. */
  close(): Promise<void>;
}
```

**`src/transports/stdio.ts`**
Extracts the existing `readline`-based logic from `MCPServer.start()` (lines 245–328 of `src/mcp-server.ts`) into a standalone class. Preserves the `rl.on('close')` → `process.exit(0)` behavior that stdio mode requires. The `send()` method writes to stdout via `console.log()` (preserving the current wire behavior).

**`src/transports/http.ts`**
Implements Streamable HTTP over `node:http`. A single `POST /mcp` endpoint reads the request body, calls the registered `onMessage` handler, and writes the JSON-RPC response to the HTTP response body (`Content-Type: application/json`). For streaming results (SSE), it writes `Content-Type: text/event-stream` and flushes `data:` frames. Does NOT call `process.exit()` on client disconnect — the server remains running between requests.

Key behaviors:
- Binds to `0.0.0.0:<port>` (configurable; default 3100)
- Each POST request is an independent JSON-RPC exchange
- Client disconnect mid-stream: abort SSE, emit warning, do not exit
- Concurrent requests: handled naturally by Node.js HTTP server (each request gets its own handler invocation)
- CORS headers for browser-based MCP clients (optional, behind a flag)

### Files to Modify

**`src/mcp-server.ts`**
1. Remove the `private rl: readline.Interface | null` field (line 100) — readline is owned by `StdioTransport` now.
2. Remove the `start()` method body (lines 232–329) — replace with `start(transport: MCPTransport): void` that calls `transport.start()` and wires `transport.onMessage(this.handleRequest.bind(this))`.
3. Change `sendResponse()` (line 334) from `console.log(JSON.stringify(response))` to `this.transport.send(response)` where `this.transport` is set at `start()` time.
4. Change `sendNotification()` (line 220) similarly — it must route through the transport.
5. The `stop()` method should call `this.transport.close()`.
6. Keep all tool registration, session management, and protocol handling logic unchanged.

**`src/index.ts`**
1. Add `--http [port]` option to the `serve` command (after line 71 where existing options are declared). Port defaults to `3100`.
2. In the serve action, after reading options, call `createTransport(options.http ? 'http' : 'stdio', { port: options.http })` to get the appropriate transport.
3. Pass the transport to `server.start(transport)`.
4. In HTTP mode: do NOT call `process.exit()` from the shutdown handler immediately — drain in-flight requests first (give 5s grace period).
5. The health endpoint (`src/watchdog/health-endpoint.ts`) is already on port 9090 and continues unchanged regardless of transport mode.

**`cli/index.ts`**
Add `--http [port]` option to the `serve` command definition (mirrors the change in `src/index.ts`). The CLI entry point (`cli/index.ts`) re-exports the `serve` command from `src/index.ts` — confirm whether it is a separate Commander program or a re-export. If separate, add the option there too.

**`package.json`**
No new runtime dependencies are required for the HTTP transport (uses `node:http`). If the MCP SDK's `StreamableHTTPServerTransport` is adopted in a later iteration, add `@modelcontextprotocol/sdk@^1.10.0` to `dependencies`.

### Implementation Steps

1. Create `src/transports/` directory.
2. Define `MCPTransport` interface in `src/transports/index.ts`.
3. Implement `StdioTransport` in `src/transports/stdio.ts` — copy readline logic from `MCPServer.start()` verbatim, then delete it from `MCPServer`.
4. Implement `HTTPTransport` in `src/transports/http.ts` — single POST endpoint, JSON response body, SSE streaming support.
5. Refactor `MCPServer` to accept transport via `start(transport)`, route `sendResponse` and `sendNotification` through `this.transport.send()`.
6. Update `src/index.ts` serve action: add `--http [port]` flag, call `createTransport()`, pass to `server.start()`.
7. Update `cli/index.ts` if it has a separate Commander definition.
8. Verify: run existing test suite (`npm test`) — zero regressions.
9. Manual smoke test: stdio mode (`openchrome serve`) still works as before.
10. Manual smoke test: HTTP mode (`openchrome serve --http 3100`) accepts `POST /mcp` with a valid `tools/list` request.
11. Write unit tests for `StdioTransport` (mock `process.stdin`/`process.stdout`) and `HTTPTransport` (use `node:http` client in tests).
12. Write E2E-13: HTTP transport independence test (server survives client disconnect, accepts new connection, state preserved).
13. Write E2E-14: multi-client test (two concurrent HTTP clients call tools simultaneously, no cross-contamination).

### Backward Compatibility

- Default behavior (`openchrome serve` without `--http`) is unchanged — uses stdio transport.
- The `rl.on('close')` → `process.exit()` behavior is preserved in `StdioTransport` only.
- HTTP mode explicitly does not exit on client disconnect.
- Existing MCP client configurations (Claude Code `~/.claude/.mcp.json`) continue to work unchanged.

---

## Phase 2: Infinite Reconnection Mode

**Priority**: HIGH
**Estimated complexity**: Medium
**Risk**: Low — additive change, fully backward compatible via default values
**Depends on**: Phase 1 (HTTP transport flag needed to select reconnection default)
**Enables**: E2E-12 (Chrome down 5 minutes test)

### Goal

When running as a daemon (`--http` mode), never give up reconnecting to Chrome. In stdio mode, keep the existing 5-attempt limit. Expose reconnection progress in the health endpoint.

### Current Behavior

`CDPClient.handleDisconnect()` (lines 392–481 of `src/cdp/client.ts`) loops `while (this.reconnectAttempts < this.maxReconnectAttempts)`. The field is initialized from `OPENCHROME_MAX_RECONNECT_ATTEMPTS` env var or `DEFAULT_MAX_RECONNECT_ATTEMPTS = 5` (`src/config/defaults.ts` line 111). After 5 failures it sets state to `'disconnected'`, stops heartbeat, emits `reconnect_failed`, and logs "Chrome will be re-launched on next tool call."

The backoff cap is hardcoded to `30000` (30s) at line 460.

### Technical Approach

Extend `CDPClientOptions` (already exists at line 43 of `src/cdp/client.ts`) with a `maxReconnectAttempts` field that accepts `Infinity`. Change the while-loop condition to handle `Infinity`. Increase the backoff cap to 60s for infinite mode. Add reconnection state fields that the health endpoint can read.

The transport mode (`stdio` vs `http`) determines the default: HTTP mode passes `Infinity` when constructing `CDPClient`; stdio mode keeps the current default of 5.

### Files to Modify

**`src/cdp/client.ts`**

1. The `CDPClientOptions.maxReconnectAttempts` field (line 45) already exists. It already reads from env var via `parseEnvInt` at line 113. No interface change needed — `parseEnvInt` returns a `number`, but `Infinity` cannot come from an env var integer parse. Add special handling: if `OPENCHROME_MAX_RECONNECT_ATTEMPTS=0`, treat as `Infinity`.

2. In `handleDisconnect()` (line 428), change the while condition from:
   ```typescript
   while (this.reconnectAttempts < this.maxReconnectAttempts)
   ```
   to:
   ```typescript
   while (this.maxReconnectAttempts === Infinity || this.reconnectAttempts < this.maxReconnectAttempts)
   ```

3. Change the backoff cap (line 460) from `30000` to:
   ```typescript
   this.maxReconnectAttempts === Infinity ? 60000 : 30000
   ```

4. Add three private fields to track reconnection state for external consumers:
   ```typescript
   private reconnecting = false;
   private reconnectingAttempt = 0;
   private reconnectNextRetryAt = 0;
   ```
   Set `this.reconnecting = true` at the start of `handleDisconnect()`, `this.reconnecting = false` on success or final failure. Set `this.reconnectingAttempt` on each loop iteration. Set `this.reconnectNextRetryAt = Date.now() + backoffDelay` before the `await setTimeout` delay.

5. Extend `getConnectionMetrics()` (line 305) to include:
   ```typescript
   reconnecting: this.reconnecting,
   reconnectingAttempt: this.reconnectingAttempt,
   reconnectNextRetryAt: this.reconnectNextRetryAt,
   ```

6. In `parseEnvInt`, or in the constructor, add: if parsed value is `0`, return `Infinity` (so `OPENCHROME_MAX_RECONNECT_ATTEMPTS=0` means infinite).

**`src/config/defaults.ts`**

Add after line 116:
```typescript
/** Max reconnect attempts in HTTP daemon mode (never give up).
 *  Use Infinity so handleDisconnect() loops until Chrome returns.
 *  In stdio mode, DEFAULT_MAX_RECONNECT_ATTEMPTS (5) remains the default. */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS_HTTP = Infinity;
```

**`src/watchdog/health-endpoint.ts`**

1. Extend `HealthData['chrome']` (line 17) to include reconnection fields:
   ```typescript
   chrome?: {
     connected: boolean;
     reconnectCount: number;
     reconnecting?: boolean;
     reconnectAttempt?: number;
     nextRetryInMs?: number;
   };
   ```

2. No changes to `HealthEndpoint` class itself — the data shape is provided by the callback in `src/index.ts`.

**`src/index.ts`**

In the health data provider callback (lines 262–282), extend the `chromeData` object:
```typescript
chromeData = {
  connected: cdpClient.getConnectionState() === 'connected',
  reconnectCount: metrics.reconnectCount,
  reconnecting: metrics.reconnecting,
  reconnectAttempt: metrics.reconnectingAttempt,
  nextRetryInMs: metrics.reconnectNextRetryAt > 0
    ? Math.max(0, metrics.reconnectNextRetryAt - Date.now())
    : undefined,
};
```

Also, when constructing `CDPClient` (via the singleton `getCDPClient()`), pass `maxReconnectAttempts: Infinity` when `options.http` is set. Since `CDPClient` is a singleton obtained via `getCDPClient()`, the options must be set before first access. Add a `setCDPClientOptions()` function analogous to `setMCPServerOptions()`, and call it before `getCDPClient()` in the serve action when `--http` is active.

**`src/tools/connection-health.ts`** (if this file exists — verify path)

If a `connection_health` tool exists, extend its output to include the `reconnecting`, `reconnectAttempt`, and `nextRetryInMs` fields from `getConnectionMetrics()`.

### Implementation Steps

1. Add `DEFAULT_MAX_RECONNECT_ATTEMPTS_HTTP = Infinity` to `src/config/defaults.ts`.
2. Extend `getConnectionMetrics()` return type with reconnection progress fields.
3. Add private reconnection state fields to `CDPClient`.
4. Update `handleDisconnect()`: condition check, backoff cap, state field updates.
5. Add `OPENCHROME_MAX_RECONNECT_ATTEMPTS=0` → `Infinity` mapping in `parseEnvInt` or constructor.
6. Extend `HealthData['chrome']` interface.
7. Update health data provider in `src/index.ts` to include reconnection state.
8. Pass `maxReconnectAttempts: Infinity` to `CDPClient` when `--http` flag is active.
9. Write unit test: mock `connectInternal` to fail N times, verify loop continues beyond 5 in infinite mode.
10. Write E2E-12: start daemon with `--http`, stop Chrome, wait 5 minutes, restart Chrome, verify daemon reconnects and serves requests.

### Backward Compatibility

- Stdio mode: `DEFAULT_MAX_RECONNECT_ATTEMPTS = 5` unchanged.
- HTTP mode: passes `Infinity` explicitly — opt-in.
- `OPENCHROME_MAX_RECONNECT_ATTEMPTS` env var still works in both modes; value `0` now means infinite.
- Health endpoint response is additive (new optional fields) — existing consumers are unaffected.

---

## Phase 3: Request Rate Limiter

**Priority**: HIGH
**Estimated complexity**: Small
**Risk**: Low — pre-execution check, no tool logic changes
**Depends on**: Nothing (can be developed independently of Phases 1–2)
**Enables**: E2E-16 (rate limiter under flood)

### Goal

Protect the server against request floods with a per-session token bucket rate limiter. Default: 60 requests per minute per session. Rejections return a proper MCP error with retry-after guidance.

### Technical Approach

Token bucket algorithm: each session gets a bucket with capacity `maxTokens` (default 60). The bucket refills at `refillRate = maxTokens / 60` tokens per second. Each request consumes one token. If the bucket is empty, the request is rejected immediately with MCP error code `-32000` (application error) and a `retryAfter` field indicating seconds until the next token is available.

Per-session bucketing prevents one runaway session from throttling others. Buckets are created on first use and cleaned up when the session is deleted.

### Files to Create

**`src/utils/rate-limiter.ts`**

```typescript
export interface RateLimiterOptions {
  maxTokens: number;       // bucket capacity (= max burst)
  refillRatePerSec: number; // tokens added per second
}

export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private readonly maxTokens: number;
  private readonly refillRatePerSec: number;

  constructor(opts: RateLimiterOptions) { ... }

  /** Returns true if a token was consumed; false if the bucket is empty. */
  consume(): boolean { ... }

  /** Seconds until the next token is available. Returns 0 if tokens > 0. */
  retryAfterSecs(): number { ... }
}
```

The `consume()` method calls a private `refill()` before checking the token count. `refill()` computes elapsed seconds since `lastRefillAt`, adds `elapsed * refillRatePerSec` tokens (capped at `maxTokens`), and updates `lastRefillAt`.

### Files to Modify

**`src/mcp-server.ts`**

1. Add a `private rateLimiters: Map<string, TokenBucket>` field.
2. At the start of `handleToolsCall()` (the method that receives `tools/call` dispatches), extract the session identifier from params. If no session ID is present, use a default key (`'__global'`).
3. Get or create a `TokenBucket` for the session key using `DEFAULT_RATE_LIMIT_PER_MIN`.
4. Call `bucket.consume()`. If it returns `false`, return an error response immediately:
   ```typescript
   return this.errorResponse(id, -32000,
     `Rate limit exceeded. Retry after ${bucket.retryAfterSecs().toFixed(1)}s.`);
   ```
5. In session cleanup (wherever `sessionManager.deleteSession()` is called internally), call `this.rateLimiters.delete(sessionId)`.

**`src/config/defaults.ts`**

Add:
```typescript
/** Default rate limit for MCP tool calls per session per minute.
 *  Override with OPENCHROME_RATE_LIMIT_PER_MIN environment variable.
 *  Set to 0 to disable rate limiting. */
export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
```

### Implementation Steps

1. Implement `TokenBucket` class in `src/utils/rate-limiter.ts` with unit tests.
2. Add `DEFAULT_RATE_LIMIT_PER_MIN` to `src/config/defaults.ts`.
3. Add `rateLimiters` map to `MCPServer`.
4. Wire rate limit check at the top of `handleToolsCall()`.
5. Wire cleanup on session delete.
6. Verify: run `npm test` — no regressions.
7. Write unit test for `TokenBucket`: burst limit, refill timing, `retryAfterSecs()` accuracy.
8. Write E2E-16: fire 120 requests/min from a single session, verify requests 61+ are rejected with `-32000` and include `retryAfter` in the message, verify requests resume after the refill window.

### Backward Compatibility

- Rate limiting is enabled by default at 60 req/min.
- `OPENCHROME_RATE_LIMIT_PER_MIN=0` disables it entirely.
- MCP error code `-32000` is within the server-defined error range per the JSON-RPC spec.

---

## Phase 4: Production Defaults

**Priority**: MEDIUM
**Estimated complexity**: Small
**Risk**: Medium — event loop fatal exit could surprise developers; async I/O change requires all callers to be updated
**Depends on**: Nothing
**Enables**: E2E-19 (event loop fatal recovery)

### Goal

Enable two safety features that are currently opt-in by default in production deployments:

1. **Event loop fatal threshold**: default 30s (currently disabled — `fatalThresholdMs` is 0 unless `OPENCHROME_EVENT_LOOP_FATAL_MS` is set).
2. **DomainMemory async I/O**: replace synchronous `fs.readFileSync`/`fs.writeFileSync` with async equivalents to prevent event loop blocking on slow disks.

### Change 4a: Event Loop Fatal Threshold Default

**File: `src/config/defaults.ts`**

The constant `DEFAULT_EVENT_LOOP_FATAL_MS` does not currently exist. Add:
```typescript
/** Default fatal threshold for event loop blocking in milliseconds.
 *  When exceeded, 'fatal' event is emitted → process.exit(1).
 *  30s is generous enough to avoid false positives under Chrome GC load,
 *  yet catches genuine runaway hangs.
 *  Override with OPENCHROME_EVENT_LOOP_FATAL_MS=0 to disable. */
export const DEFAULT_EVENT_LOOP_FATAL_MS = 30000;
```

**File: `src/index.ts`**

At line 241 (EventLoopMonitor construction):
```typescript
// Before:
fatalThresholdMs: parseInt(process.env.OPENCHROME_EVENT_LOOP_FATAL_MS || '', 10) || 0,

// After:
fatalThresholdMs: parseInt(process.env.OPENCHROME_EVENT_LOOP_FATAL_MS || '', 10) || DEFAULT_EVENT_LOOP_FATAL_MS,
```

Import `DEFAULT_EVENT_LOOP_FATAL_MS` in the imports block (line 35).

**Developer escape hatch**: `OPENCHROME_EVENT_LOOP_FATAL_MS=0` disables the fatal threshold entirely (preserves current behavior for local development). This must be documented in the README.

### Change 4b: DomainMemory Async I/O

**File: `src/memory/domain-memory.ts`**

Current state: `load()` (line 171) uses `fs.readFileSync`; `save()` (line 182) uses `fs.writeFileSync`. Both are called synchronously from `record()`, `validate()`, `compress()`, and `enablePersistence()`.

Refactor approach:

1. Change `save()` to `async save(): Promise<void>` using `fs.promises.writeFile`.
2. Change `load()` to `async load(): Promise<void>` using `fs.promises.readFile`.
3. Change `enablePersistence()` to `async enablePersistence(dirPath: string): Promise<void>`.
4. All callers of `save()` within `DomainMemory` (record, validate, compress) call it fire-and-forget with `.catch(err => console.error('[DomainMemory] Save error:', err))` — the I/O is best-effort and should not block the caller.
5. `getDomainMemory()` (line 203) calls `instance.enablePersistence()` — change to `instance.enablePersistence(memoryDir).catch(...)`.

**Note on callers outside domain-memory.ts**: run a codebase grep for `getDomainMemory()` and `domainMemory.save()` / `domainMemory.load()` to identify all callers. Update each to handle the async return. The primary callers are in the memory-related tools (verify `src/tools/` for any direct `save()`/`load()` calls).

### Implementation Steps

1. Add `DEFAULT_EVENT_LOOP_FATAL_MS = 30000` to `src/config/defaults.ts`.
2. Update `src/index.ts` EventLoopMonitor construction to use the new default.
3. Run `npm test` — verify event loop tests still pass (the monitor emits `'fatal'`, does not auto-exit; `process.exit(1)` is wired in `src/index.ts` line 244).
4. Refactor `DomainMemory.save()` and `load()` to async.
5. Refactor `DomainMemory.enablePersistence()` to async.
6. Update `getDomainMemory()` to await or fire-and-forget the async `enablePersistence`.
7. Search for all callers of `save()`/`load()` outside `domain-memory.ts` and update.
8. Run `npm test` — zero regressions.
9. Write E2E-19: start server, trigger a large synchronous operation that would block the event loop beyond 30s (e.g., artificial busy-wait in a test tool), verify process exits and systemd/PM2 restarts it.

### Backward Compatibility

- Event loop fatal: `OPENCHROME_EVENT_LOOP_FATAL_MS=0` restores the old "disabled" behavior. Existing `--server-mode` deployments that set this env var are unaffected.
- DomainMemory async: the public API (`record()`, `query()`, `validate()`) remains synchronous from the caller's perspective — only `save()`/`load()` become async internally. No external API change.

---

## Phase 5: Prometheus Metrics Export

**Priority**: MEDIUM
**Estimated complexity**: Medium
**Risk**: Low — observability only, no behavior changes
**Depends on**: Phase 1 (health endpoint port shared; HTTP server already running)
**Enables**: E2E-17 (metrics accuracy test), external Prometheus scraping

### Goal

Add a `/metrics` endpoint alongside the existing `/health` endpoint on port 9090, exposing standard Prometheus text format metrics for tool calls, reconnections, memory, sessions, and tab health.

### Technical Approach

Hand-roll the Prometheus text format (no `prom-client` dependency) to keep the dependency footprint minimal. The format is simple enough: `# HELP`, `# TYPE`, and metric lines. Implement a `MetricsCollector` singleton that accumulates counters, gauges, and histograms. Instrument key call sites. The `HealthEndpoint` adds a `/metrics` route.

If `prom-client` is preferred for histogram bucket accuracy, add it as a dependency. The hand-rolled approach is sufficient for the metrics listed in the requirements and avoids a new dependency.

### Metrics to Expose

```
# HELP openchrome_tool_calls_total Total MCP tool calls by tool name and status
# TYPE openchrome_tool_calls_total counter
openchrome_tool_calls_total{tool="navigate",status="success"} 1234
openchrome_tool_calls_total{tool="navigate",status="error"} 5

# HELP openchrome_tool_duration_seconds Tool call duration distribution
# TYPE openchrome_tool_duration_seconds histogram
openchrome_tool_duration_seconds_bucket{tool="navigate",le="0.1"} 10
openchrome_tool_duration_seconds_bucket{tool="navigate",le="0.5"} 80
openchrome_tool_duration_seconds_bucket{tool="navigate",le="1"} 100
openchrome_tool_duration_seconds_bucket{tool="navigate",le="5"} 120
openchrome_tool_duration_seconds_bucket{tool="navigate",le="+Inf"} 125
openchrome_tool_duration_seconds_sum{tool="navigate"} 45.2
openchrome_tool_duration_seconds_count{tool="navigate"} 125

# HELP openchrome_reconnect_total Total CDP reconnection attempts
# TYPE openchrome_reconnect_total counter
openchrome_reconnect_total 5

# HELP openchrome_heap_bytes Current V8 heap usage in bytes
# TYPE openchrome_heap_bytes gauge
openchrome_heap_bytes 52428800

# HELP openchrome_active_sessions Current number of active sessions
# TYPE openchrome_active_sessions gauge
openchrome_active_sessions 3

# HELP openchrome_tabs_health Tab health status counts
# TYPE openchrome_tabs_health gauge
openchrome_tabs_health{status="healthy"} 4
openchrome_tabs_health{status="unhealthy"} 1

# HELP openchrome_rate_limit_rejections_total Tool calls rejected by rate limiter
# TYPE openchrome_rate_limit_rejections_total counter
openchrome_rate_limit_rejections_total 0
```

### Files to Create

**`src/metrics/collector.ts`**

`MetricsCollector` singleton with the following API:
```typescript
class MetricsCollector {
  incrementCounter(name: string, labels: Record<string, string>, value?: number): void;
  setGauge(name: string, labels: Record<string, string>, value: number): void;
  observeHistogram(name: string, labels: Record<string, string>, value: number): void;
  getMetrics(): string; // returns Prometheus text format
}
```

Counters and gauges are stored in `Map<string, number>` keyed by `name + JSON.stringify(labels)`. Histograms use fixed buckets `[0.1, 0.5, 1, 5, 30, 120]` seconds. The `getMetrics()` method renders all registered metrics into the Prometheus text exposition format.

**`src/metrics/exporter.ts`**

Thin wrapper: calls `collector.getMetrics()` and returns the string for the HTTP handler. Also provides `registerMetricHelp(name, help, type)` so metrics are registered with `# HELP` and `# TYPE` headers before first data arrives.

### Files to Modify

**`src/watchdog/health-endpoint.ts`**

1. Add a `/metrics` route in the request handler (after line 48 where `/health` is checked):
   ```typescript
   if (req.url === '/metrics' && req.method === 'GET') {
     const body = getMetricsExporter().export();
     res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
     res.end(body);
     return;
   }
   ```
2. No changes to `HealthData` interface or `HealthEndpoint` constructor.

**`src/mcp-server.ts`**

In `handleToolsCall()` (called from `handleRequest()` line 358):
1. Record the start time before tool dispatch.
2. After the tool handler returns (success or error), call:
   ```typescript
   metrics.incrementCounter('openchrome_tool_calls_total', { tool: toolName, status });
   metrics.observeHistogram('openchrome_tool_duration_seconds', { tool: toolName }, durationSec);
   ```
3. If the rate limiter rejects a request (Phase 3), increment `openchrome_rate_limit_rejections_total`.

**`src/cdp/client.ts`**

In `handleDisconnect()`, after the `reconnectCount++` increment (line 447):
```typescript
getMetricsCollector().incrementCounter('openchrome_reconnect_total', {}, 1);
```

In the health endpoint callback in `src/index.ts`, update gauges for sessions and tabs on each health check invocation (or use a periodic flush from the metrics collector).

### Implementation Steps

1. Create `src/metrics/` directory.
2. Implement `MetricsCollector` with counter/gauge/histogram support.
3. Implement `MetricsExporter` (Prometheus text format renderer).
4. Add `/metrics` route to `HealthEndpoint`.
5. Instrument `MCPServer.handleToolsCall()` for tool call counter and duration histogram.
6. Instrument `CDPClient.handleDisconnect()` for reconnect counter.
7. Update `src/index.ts` health callback to set gauges for sessions, tabs, heap.
8. Run `npm test` — no regressions.
9. Write unit test for `MetricsCollector`: verify counter increments, gauge sets, histogram bucket placement.
10. Write E2E-17: make 10 `navigate` calls, 3 of which fail; scrape `/metrics`; verify `openchrome_tool_calls_total{status="success"}=7` and `openchrome_tool_calls_total{status="error"}=3`.

### Backward Compatibility

- `/metrics` is a new route — existing `/health` consumers are unaffected.
- Metrics collection is in-process (no external dependencies).
- The `getMetricsCollector()` singleton is safe to call from any module.

---

## Phase 6: Deployment Infrastructure

**Priority**: MEDIUM
**Estimated complexity**: Small
**Risk**: Low — additive files, no code changes
**Depends on**: Phase 1 (all configs reference `--http` flag)
**Enables**: Production daemon deployments on Linux, Docker, and PM2

### Goal

Provide ready-to-use deployment configurations for systemd, Docker, and PM2.

### Files to Create

**`deploy/systemd/openchrome.service`**

```ini
[Unit]
Description=OpenChrome MCP Server
Documentation=https://github.com/shaun0927/openchrome
After=network.target
Wants=network.target

[Service]
Type=simple
User=openchrome
Group=openchrome
WorkingDirectory=/opt/openchrome
ExecStart=/usr/bin/openchrome serve --http 3100 --server-mode
ExecStartPost=/bin/sh -c 'until curl -sf http://127.0.0.1:9090/health; do sleep 1; done'
Restart=always
RestartSec=3
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=30

# Resource limits
LimitNOFILE=65536
MemoryMax=1G

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=openchrome

# Security hardening
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

**`deploy/docker/Dockerfile`**

```dockerfile
FROM node:22-slim

# Install Chromium and dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    curl \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built artifacts (assumes `npm run build` was run before docker build)
COPY dist/ ./dist/
COPY assets/ ./assets/

# Non-root user
RUN useradd -r -s /bin/false openchrome && \
    chown -R openchrome:openchrome /app
USER openchrome

# Health check using existing health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -sf http://127.0.0.1:9090/health || exit 1

EXPOSE 3100 9090

ENV CHROME_BINARY=/usr/bin/chromium

CMD ["node", "dist/index.js", "serve", "--http", "3100", "--server-mode"]
```

**`deploy/docker/docker-compose.yml`**

```yaml
services:
  openchrome:
    build: .
    restart: unless-stopped
    ports:
      - "3100:3100"
      - "9090:9090"
    environment:
      - OPENCHROME_MAX_RECONNECT_ATTEMPTS=0  # infinite in HTTP mode
      - OPENCHROME_HEALTH_PORT=9090
    volumes:
      - openchrome-state:/home/openchrome/.openchrome
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://127.0.0.1:9090/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s

volumes:
  openchrome-state:
```

**`deploy/pm2/ecosystem.config.js`**

```javascript
module.exports = {
  apps: [
    {
      name: 'openchrome',
      script: 'dist/index.js',
      args: 'serve --http 3100 --server-mode',
      interpreter: 'node',
      exp_backoff_restart_delay: 100,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        OPENCHROME_MAX_RECONNECT_ATTEMPTS: '0',
        OPENCHROME_HEALTH_PORT: '9090',
      },
      error_file: 'logs/openchrome-error.log',
      out_file: 'logs/openchrome-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
```

### Implementation Steps

1. Create `deploy/` directory with subdirectories `systemd/`, `docker/`, `pm2/`.
2. Write the four files above.
3. Verify Dockerfile builds correctly against the existing `dist/` output: `docker build -f deploy/docker/Dockerfile .`
4. Verify docker-compose health check references the correct port.
5. Add a `deploy/README.md` with brief setup instructions for each deployment method (optional but recommended).

### Backward Compatibility

All deployment files are additive. No existing files are modified.

---

## Phase 7: Disk Space Monitoring

**Priority**: LOW
**Estimated complexity**: Small
**Risk**: Low — cleanup of own files only, best-effort
**Depends on**: Nothing
**Enables**: E2E-18 (disk space auto-cleanup test)

### Goal

Prevent disk full conditions caused by accumulating state files under `~/.openchrome/`. Monitor total directory size every 5 minutes, auto-prune old files, and expose disk usage in the health endpoint.

### Technical Approach

A `DiskMonitor` class uses `fs.promises` to walk `~/.openchrome/` and compute total size via `stat()` calls. On exceeding thresholds, it prunes files by age and count rules. The walk is async and non-blocking. A periodic `setInterval` triggers the check every 5 minutes; the timer is `.unref()`'d to avoid keeping the process alive.

### Pruning Rules

| Storage Type | Location | Retention Rule |
|---|---|---|
| Task journals | `~/.openchrome/journal/` | Delete entries older than 7 days |
| Session snapshots | `~/.openchrome/sessions/` | Keep newest 10; delete older than 30 days |
| Checkpoints | `~/.openchrome/checkpoints/` | Keep newest 10 |
| Memory | `~/.openchrome/memory/` | DomainMemory.compress() handles this already |

Warn at 500MB total. Aggressive cleanup (all but most recent per category) at 1GB total.

### Files to Create

**`src/utils/disk-monitor.ts`**

```typescript
export interface DiskMonitorOptions {
  dirPath: string;
  checkIntervalMs: number;    // default 5 minutes
  warnThresholdBytes: number; // default 500MB
  maxThresholdBytes: number;  // default 1GB
}

export class DiskMonitor extends EventEmitter {
  start(): void;
  stop(): void;
  async getDirectorySize(dirPath: string): Promise<number>;
  async pruneJournals(maxAgeDays: number): Promise<number>;     // returns bytes freed
  async pruneSnapshots(maxCount: number, maxAgeDays: number): Promise<number>;
  async pruneCheckpoints(maxCount: number): Promise<number>;
  async runCheck(): Promise<{ totalBytes: number; freed: number }>;
}
```

The `start()` method sets a `setInterval` that calls `runCheck()` and `.unref()`'s the timer. `runCheck()` gets the total size, decides whether to prune based on thresholds, runs pruning if needed, and emits `'warn'` or `'cleanup'` events with the totals.

### Files to Modify

**`src/config/defaults.ts`**

Add:
```typescript
/** Disk monitor check interval in milliseconds (5 minutes). */
export const DEFAULT_DISK_MONITOR_INTERVAL_MS = 300000;

/** Disk usage warn threshold in bytes (500MB). */
export const DEFAULT_DISK_WARN_THRESHOLD_BYTES = 500 * 1024 * 1024;

/** Disk usage aggressive cleanup threshold in bytes (1GB). */
export const DEFAULT_DISK_MAX_THRESHOLD_BYTES = 1024 * 1024 * 1024;

/** Maximum journal age before pruning (days). */
export const DEFAULT_JOURNAL_MAX_AGE_DAYS = 7;

/** Maximum number of session snapshots to retain. */
export const DEFAULT_MAX_SESSION_SNAPSHOTS = 10;

/** Maximum session snapshot age before pruning (days). */
export const DEFAULT_SNAPSHOT_MAX_AGE_DAYS = 30;

/** Maximum number of checkpoints to retain. */
export const DEFAULT_MAX_CHECKPOINTS = 10;
```

**`src/index.ts`**

1. Import `DiskMonitor` and the new defaults.
2. After the existing `SessionStatePersistence` setup (line 289), add:
   ```typescript
   const diskMonitor = new DiskMonitor({
     dirPath: path.join(os.homedir(), '.openchrome'),
     checkIntervalMs: DEFAULT_DISK_MONITOR_INTERVAL_MS,
     warnThresholdBytes: DEFAULT_DISK_WARN_THRESHOLD_BYTES,
     maxThresholdBytes: DEFAULT_DISK_MAX_THRESHOLD_BYTES,
   });
   diskMonitor.on('warn', ({ totalBytes }: { totalBytes: number }) => {
     console.error(`[DiskMonitor] Warn: ~/.openchrome is ${(totalBytes / 1e6).toFixed(0)}MB`);
   });
   diskMonitor.on('cleanup', ({ freed }: { freed: number }) => {
     console.error(`[DiskMonitor] Cleanup: freed ${(freed / 1e6).toFixed(0)}MB`);
   });
   diskMonitor.start();
   ```
3. In the enhanced shutdown handler, add `diskMonitor.stop()`.

**`src/watchdog/health-endpoint.ts`**

1. Extend `HealthData` to include an optional `disk` field:
   ```typescript
   disk?: {
     totalBytes: number;
     status: 'ok' | 'warn' | 'critical';
   };
   ```
2. No changes to `HealthEndpoint` class — the `disk` field is populated by the provider in `src/index.ts`.

In `src/index.ts`, extend the health data provider to include `disk` if available (store latest `runCheck()` result in a variable that the provider closure reads).

### Implementation Steps

1. Add disk constants to `src/config/defaults.ts`.
2. Implement `DiskMonitor` class in `src/utils/disk-monitor.ts`.
3. Write unit tests for `DiskMonitor`: mock `fs.promises.stat`, verify pruning logic and threshold triggers.
4. Extend `HealthData` interface in `src/watchdog/health-endpoint.ts`.
5. Wire `DiskMonitor` startup and shutdown in `src/index.ts`.
6. Update health data provider to include disk usage.
7. Run `npm test` — no regressions.
8. Write E2E-18: populate `~/.openchrome/journal/` with 200 fake journal files older than 7 days; start server; wait for first disk check; verify files are pruned and `GET /health` returns `disk.status: "ok"`.

### Backward Compatibility

- Disk monitoring is new and additive.
- `DiskMonitor` only touches files under `~/.openchrome/` — no other paths are modified.
- The timer is `.unref()`'d — it does not affect process lifecycle.

---

## Timeline and Phase Ordering

### Sequential Dependencies

```
Phase 1 (HTTP Transport)
    └── Phase 2 (Infinite Reconnection) — needs --http flag to set CDPClient default
    └── Phase 5 (Prometheus Metrics) — /metrics lives on the health endpoint HTTP server
    └── Phase 6 (Deployment Infrastructure) — all configs reference --http flag
```

### Parallel Development

Once Phase 1 is merged to `develop`, the following phases can be developed in parallel by different engineers:

| Work stream A | Work stream B | Work stream C |
|---|---|---|
| Phase 2 (Infinite Reconnection) | Phase 3 (Rate Limiter) | Phase 4 (Production Defaults) |
| Phase 5 (Prometheus Metrics) | Phase 7 (Disk Monitor) | Phase 6 (Deployment) |

Phase 3 (Rate Limiter) has no dependencies and can start immediately in parallel with Phase 1.

Phase 4 (Production Defaults) has no dependencies and can start immediately.

Phase 7 (Disk Monitor) has no dependencies and can start at any time.

### Recommended Milestone Groupings

**Milestone 1 — Daemon foundation** (Phases 1 + 2): Delivers `openchrome serve --http` with reliable reconnection. This is the core capability that everything else builds on.

**Milestone 2 — Hardening** (Phases 3 + 4): Rate limiter and production defaults. Can ship as a single PR after Milestone 1.

**Milestone 3 — Observability** (Phase 5): Prometheus metrics. Ships after Milestone 1.

**Milestone 4 — Operations** (Phases 6 + 7): Deployment files and disk monitoring. Lowest risk, can ship anytime after Milestone 1.

---

## npm Dependencies to Add

| Package | Version | Phase | Justification |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.10.0` | Phase 1 (optional) | `StreamableHTTPServerTransport` if adopted instead of hand-rolled HTTP; skip if hand-rolling |
| *(none otherwise)* | | | All other phases use Node.js built-ins (`node:http`, `fs.promises`, `events`) |

No `prom-client` dependency is required if Prometheus text format is hand-rolled in Phase 5.

Run `npm install` after any `package.json` change and commit both `package.json` and `package-lock.json` together.

---

## Migration Notes

### For Existing stdio Users

No migration required. `openchrome serve` without `--http` continues to work exactly as before. The transport refactor in Phase 1 preserves all current stdio behavior including the `rl.on('close')` → `process.exit()` lifecycle.

### For the Event Loop Fatal Threshold (Phase 4)

This is the highest-impact default change for existing users. Any deployment where the Node.js event loop occasionally blocks for more than 30 seconds (e.g., under heavy memory pressure, large screenshot encoding, slow disk I/O) will now trigger `process.exit(1)`. To preserve current behavior:

```bash
export OPENCHROME_EVENT_LOOP_FATAL_MS=0
```

Or in the MCP client config:
```json
{
  "mcpServers": {
    "openchrome": {
      "command": "openchrome",
      "args": ["serve"],
      "env": { "OPENCHROME_EVENT_LOOP_FATAL_MS": "0" }
    }
  }
}
```

This escape hatch must be documented prominently in the release notes for the version that ships Phase 4.

### For Claude Code MCP Configurations

Existing `~/.claude/.mcp.json` entries using stdio transport require no changes. New daemon deployments should use HTTP transport with a remote MCP client configuration pointing to `http://host:3100/mcp`.

---

## E2E Test Reference

| Test ID | Phase | Description |
|---|---|---|
| E2E-12 | Phase 2 | Chrome down 5 minutes — daemon reconnects without losing state |
| E2E-13 | Phase 1 | HTTP transport independence — server survives client disconnect |
| E2E-14 | Phase 1 | Multi-client concurrency — two HTTP clients operate simultaneously |
| E2E-16 | Phase 3 | Rate limiter under flood — requests 61+ rejected with retryAfter |
| E2E-17 | Phase 5 | Metrics accuracy — counter and histogram values match actual calls |
| E2E-18 | Phase 7 | Disk space auto-cleanup — old journals pruned automatically |
| E2E-19 | Phase 4 | Event loop fatal recovery — process exits and restarts on 30s block |
