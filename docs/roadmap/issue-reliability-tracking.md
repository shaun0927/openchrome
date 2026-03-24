# Reliability Guarantee Initiative — Master Tracking Issue

> **Philosophy:** Every tool call MUST return a result — success or error — within the timeout. OpenChrome never hangs.

---

## 1. Overview & Philosophy

OpenChrome's core contract is simple: every MCP tool call returns a result. Not eventually, not usually — always, within the declared timeout. This initiative implements the infrastructure required to make that contract unconditional in production: across Chrome crashes, network disruptions, client disconnects, memory pressure, and long-running daemon sessions.

**Responsibility boundary:**

| OpenChrome IS responsible for | OpenChrome is NOT responsible for |
|-------------------------------|-----------------------------------|
| Per-tool-call result guarantee | Multi-step task orchestration |
| Server-level resilience | AI agent lifecycle management |
| Browser state preservation across reconnects | 24/7 uptime SLA guarantees |
| Health and metrics observability | Authentication/authorization |
| Graceful degradation under pressure | Browser automation logic changes |

This initiative spans 7 phases, each shipped as an independent PR against `develop`.

---

## 2. Implementation Summary

### Phase 1 — Streamable HTTP Transport

**Goal:** Replace the stdio-only transport with a dual-mode server that supports both stdio (existing) and Streamable HTTP (new daemon mode), enabling OpenChrome to run as a persistent background process independent of any single client connection.

**Key Changes:**
- New `src/transports/` module with `stdio.ts`, `http.ts`, and `index.ts` transport router
- `McpServer` refactored to be transport-agnostic (removed hardcoded stdio assumptions)
- HTTP transport implements MCP Streamable HTTP spec (2025-03-26): POST `/mcp` for calls, GET `/mcp` for SSE stream
- `--http <port>` CLI flag to start in HTTP daemon mode
- Server stays alive when HTTP client disconnects (process lifecycle decoupled from transport)
- `src/index.ts` updated to route to correct transport at startup

**PR:** #392 — feat: add Streamable HTTP transport for daemon mode

**Files Changed:**
- `src/index.ts`
- `src/mcp-server.ts`
- `src/transports/http.ts` (new)
- `src/transports/index.ts` (new)
- `src/transports/stdio.ts` (new)

**Configuration:**
- `--http <port>` — start HTTP daemon on specified port (e.g. `3100`)
- `--auto-launch` — launch Chrome automatically on startup
- `--server-mode` — suppress interactive prompts

**Status:** - [ ] Merged

---

### Phase 2 — Infinite Reconnection Mode

**Goal:** Make the Chrome DevTools Protocol (CDP) connection self-healing so that Chrome crashes, restarts, or temporary debug port unavailability never permanently break the server.

**Key Changes:**
- `src/cdp/client.ts` — reconnection loop with exponential backoff, configurable max attempts (unlimited = infinite)
- `src/config/defaults.ts` — `OPENCHROME_RECONNECT_MAX_ATTEMPTS` (default: `0` = infinite), `OPENCHROME_RECONNECT_BASE_DELAY_MS` (default: `1000`), `OPENCHROME_RECONNECT_MAX_DELAY_MS` (default: `30000`)
- `src/index.ts` — wires reconnection config into CDP client at startup
- `src/tools/connection-health.ts` — exposes reconnection state in health check
- `src/watchdog/health-endpoint.ts` — includes reconnection attempt count in `/health` response

**PR:** #395 — feat: add infinite reconnection mode for HTTP daemon

**Files Changed:**
- `src/cdp/client.ts`
- `src/config/defaults.ts`
- `src/index.ts`
- `src/mcp-server.ts`
- `src/tools/connection-health.ts`
- `src/transports/http.ts`
- `src/transports/index.ts`
- `src/transports/stdio.ts`
- `src/watchdog/health-endpoint.ts`

**Configuration:**
- `OPENCHROME_RECONNECT_MAX_ATTEMPTS` — `0` = infinite, any positive integer = hard limit
- `OPENCHROME_RECONNECT_BASE_DELAY_MS` — initial backoff delay (default: `1000`)
- `OPENCHROME_RECONNECT_MAX_DELAY_MS` — maximum backoff ceiling (default: `30000`)

**Status:** - [ ] Merged

---

### Phase 3 — Request Rate Limiter

**Goal:** Protect the server from request floods that would exhaust CDP connections or Chrome resources, ensuring degradation is graceful (clean rejection) rather than catastrophic (hang or crash).

**Key Changes:**
- `src/utils/rate-limiter.ts` (new) — sliding-window rate limiter, per-session keyed by HTTP client identity
- `src/mcp-server.ts` — rate limiter middleware applied before tool dispatch; over-limit requests return JSON-RPC error immediately (no queuing, no hang)
- `src/config/defaults.ts` — `OPENCHROME_RATE_LIMIT_RPM` (default: `120`), `OPENCHROME_RATE_LIMIT_BURST` (default: `20`)

**PR:** #397 — feat: add per-session request rate limiter

**Files Changed:**
- `src/config/defaults.ts`
- `src/mcp-server.ts`
- `src/utils/rate-limiter.ts` (new)

**Configuration:**
- `OPENCHROME_RATE_LIMIT_RPM` — requests per minute limit per session (default: `120`)
- `OPENCHROME_RATE_LIMIT_BURST` — burst allowance above sustained rate (default: `20`)
- Set to `0` to disable rate limiting entirely

**Status:** - [ ] Merged

---

### Phase 4 — Production Safety Defaults

**Goal:** Harden the runtime against two silent failure modes that cause hangs in long-running daemons: synchronous I/O blocking the Node.js event loop, and undetected event loop stalls that prevent timeouts from firing.

**Key Changes:**
- `src/config/defaults.ts` — `OPENCHROME_ASYNC_IO` flag (default: `true` in HTTP mode), `OPENCHROME_EVENT_LOOP_FATAL_MS` threshold (default: `30000`)
- `src/index.ts` — event loop lag watchdog: samples `setImmediate` latency every 1s; if lag exceeds threshold, logs to `console.error()` and calls `process.exit(1)` with a non-zero code
- `src/memory/domain-memory.ts` — async file I/O path used when `OPENCHROME_ASYNC_IO=true`, eliminating `fs.writeFileSync` calls on the hot path

**PR:** #398 — feat: enable production safety defaults

**Files Changed:**
- `src/config/defaults.ts`
- `src/index.ts`
- `src/memory/domain-memory.ts`

**Configuration:**
- `OPENCHROME_ASYNC_IO` — `true`/`false`, enables async file operations (default: `true`)
- `OPENCHROME_EVENT_LOOP_FATAL_MS` — event loop stall threshold in ms before process exit (default: `30000`); set to `0` to disable

**Status:** - [ ] Merged

---

### Phase 5 — Prometheus Metrics Export

**Goal:** Provide operational visibility into server health and tool call performance via a standard Prometheus scrape endpoint, enabling dashboards, alerting, and capacity planning.

**Key Changes:**
- `src/metrics/collector.ts` (new) — singleton metrics registry tracking: `tool_calls_total{tool,status}`, `tool_call_duration_seconds{tool}` (histogram), `reconnection_attempts_total`, `rate_limited_requests_total`, `active_sessions`
- `src/watchdog/health-endpoint.ts` — `/metrics` route added alongside `/health`, returns Prometheus text format (no extra dependency, hand-serialized)
- `src/mcp-server.ts` — instruments every tool dispatch with call count and duration recording

**PR:** #399 — feat: add Prometheus metrics export endpoint

**Files Changed:**
- `src/mcp-server.ts`
- `src/metrics/collector.ts` (new)
- `src/watchdog/health-endpoint.ts`

**Configuration:**
- `OPENCHROME_METRICS_PORT` — port for `/health` and `/metrics` endpoints (default: `9090`)
- Metrics endpoint is always enabled when running in HTTP mode; no flag to disable

**Status:** - [ ] Merged

---

### Phase 6 — Deployment Infrastructure

**Goal:** Provide production-ready deployment artifacts for the three most common long-running daemon patterns: systemd (Linux servers), Docker (containerized environments), and PM2 (Node.js process managers).

**Key Changes:**
- `deploy/systemd/openchrome.service` — systemd unit with `Restart=always`, `RestartSec=3`, `KillMode=control-group` (prevents orphan Chrome processes), resource limits
- `deploy/systemd/openchrome.env` — environment variable template for systemd deployment
- `deploy/docker/Dockerfile` — multi-stage build, non-root user, Chrome sandbox flags for containers
- `deploy/docker/docker-compose.yml` — service definition with volume mount for session state, health check wired to `/health`
- `deploy/docker/.dockerignore` — excludes node_modules, test fixtures, dev configs
- `deploy/pm2/ecosystem.config.js` — PM2 ecosystem config with `max_memory_restart`, `exp_backoff_restart_delay`, log paths

**PR:** #400 — feat: add deployment infrastructure (systemd, Docker, PM2)

**Files Changed:**
- `deploy/docker/.dockerignore` (new)
- `deploy/docker/Dockerfile` (new)
- `deploy/docker/docker-compose.yml` (new)
- `deploy/pm2/ecosystem.config.js` (new)
- `deploy/systemd/openchrome.env` (new)
- `deploy/systemd/openchrome.service` (new)

**Configuration:**
- All configuration via environment variables; see `deploy/systemd/openchrome.env` for full template
- Docker volume: `/home/openchrome/.openchrome` for session state persistence

**Status:** - [ ] Merged

---

### Phase 7 — Disk Space Monitoring

**Goal:** Prevent long-running daemons from consuming unbounded disk space through checkpoint accumulation, with automatic pruning when limits are approached and visibility into current usage via the health endpoint.

**Key Changes:**
- `src/watchdog/disk-monitor.ts` (new) — periodic scan of `~/.openchrome/` directory; when total size exceeds `OPENCHROME_DISK_MAX_MB`, deletes oldest checkpoint files until under `OPENCHROME_DISK_TARGET_MB`
- `src/watchdog/health-endpoint.ts` — `/health` response extended with `disk: { usedMb, limitMb, pruneCount }` field
- `src/index.ts` — disk monitor started alongside other watchdogs in HTTP mode
- `src/config/defaults.ts` — disk limit and target constants

**PR:** #402 — feat: add disk space monitoring and auto-pruning

**Files Changed:**
- `src/config/defaults.ts`
- `src/index.ts`
- `src/watchdog/disk-monitor.ts` (new)
- `src/watchdog/health-endpoint.ts`

**Configuration:**
- `OPENCHROME_DISK_MAX_MB` — disk usage threshold that triggers pruning (default: `500`)
- `OPENCHROME_DISK_TARGET_MB` — target disk usage after pruning (default: `400`)
- `OPENCHROME_DISK_CHECK_INTERVAL_MS` — how often to check disk usage (default: `60000`)

**Status:** - [ ] Merged

---

## 3. Pre-Merge Checklist

Apply to each PR before merging:

- [ ] Build passes (`npm run build`)
- [ ] All 2116 existing tests pass (`npm test`)
- [ ] No new npm dependencies added
- [ ] Backward compatible with existing stdio mode (`openchrome serve` with no flags unchanged)
- [ ] `console.error()` used for all logging (never `console.log()` — corrupts MCP JSON-RPC on stdio)
- [ ] `os.homedir()` used instead of `process.env.HOME`
- [ ] `path.join()` used for all file paths
- [ ] Code review approved

---

## 4. Post-Merge Integration Checklist

After all 7 PRs are merged to `develop`:

- [ ] All 7 PRs merged to develop
- [ ] Combined build passes (`npm run build` with all phases together)
- [ ] Combined test suite passes (`npm test` — all 2116 tests green)
- [ ] No import conflicts between phases (check for duplicate singleton registrations)
- [ ] `openchrome serve` (stdio mode, no flags) works as before — zero regression
- [ ] `openchrome serve --http 3100` starts HTTP daemon and logs ready message
- [ ] `openchrome serve --http 3100 --auto-launch --server-mode` starts fully autonomous
- [ ] `/health` endpoint includes all Phase 2 (reconnection), Phase 5 (metrics summary), and Phase 7 (disk) fields
- [ ] `/metrics` endpoint returns valid Prometheus text format
- [ ] Rate limiter active in HTTP mode, absent in stdio mode

---

## 5. Deployment Verification Checklist

### 5.1 Local Smoke Test

- [ ] `openchrome serve --http 3100 --auto-launch --server-mode` starts successfully
- [ ] `curl http://localhost:3100/mcp` with initialize request returns valid JSON-RPC response
- [ ] `curl http://localhost:9090/health` returns `{"status":"ok",...}`
- [ ] `curl http://localhost:9090/metrics` returns Prometheus text format
- [ ] Kill the curl client → server stays alive (HTTP independence verified via `/health`)
- [ ] Kill Chrome (`kill -9 <chrome-pid>`) → server logs reconnection attempts to stderr
- [ ] Chrome relaunches → server reconnects automatically (next tool call succeeds)
- [ ] Send 200 rapid requests → first ~120 succeed, remainder get JSON-RPC rate-limit rejection (not hang)
- [ ] Block event loop artificially for >30s → process exits with non-zero code (event loop watchdog fires)
- [ ] `~/.openchrome/` disk usage appears in `/health` response under `disk` field

### 5.2 systemd Deployment

- [ ] `sudo cp deploy/systemd/openchrome.service /etc/systemd/system/`
- [ ] `sudo systemctl daemon-reload`
- [ ] `sudo systemctl enable --now openchrome`
- [ ] `systemctl status openchrome` shows `active (running)`
- [ ] `curl http://localhost:9090/health` returns `{"status":"ok",...}`
- [ ] `sudo systemctl stop openchrome` → graceful shutdown, no orphan Chrome processes (`pgrep chrome` returns nothing)
- [ ] `sudo kill -9 <openchrome-pid>` → systemd restarts within 3 seconds
- [ ] After restart: Chrome reconnects, tool calls succeed within 30s

### 5.3 Docker Deployment

- [ ] `docker build -t openchrome -f deploy/docker/Dockerfile .` succeeds (no build errors)
- [ ] `docker compose -f deploy/docker/docker-compose.yml up -d` starts without errors
- [ ] `docker compose logs openchrome` shows "Ready, waiting for requests"
- [ ] `curl http://localhost:3100/mcp` with tool call returns valid JSON-RPC response
- [ ] `docker compose restart openchrome` → recovers within 10s
- [ ] `docker compose down && docker compose up -d` → volume persists session state (cookie survives restart)

### 5.4 PM2 Deployment

- [ ] `pm2 start deploy/pm2/ecosystem.config.js` starts without error
- [ ] `pm2 status` shows openchrome `online`
- [ ] `pm2 stop openchrome && pm2 start openchrome` → recovers, tool calls succeed
- [ ] `pm2 monit` shows memory < 500MB under normal load

---

## 6. Real-World Task Validation Checklist

These scenarios test the reliability guarantee under real conditions. All must pass before declaring the initiative complete.

### 6.1 Basic Tool Call Guarantee

- [ ] `navigate` to google.com → returns success with `tabId` within 30s
- [ ] `read_page` on the navigated tab → returns non-empty page content
- [ ] `interact` click on search input → returns success
- [ ] `fill_form` with search text → returns success
- [ ] `cookies` set/get → round-trip succeeds (value read back equals value written)
- [ ] `javascript_tool` execute `document.title` → returns correct title string
- [ ] Unknown tool name → returns JSON-RPC error (not a hang)
- [ ] Malformed tool arguments → returns JSON-RPC error (not a hang)

### 6.2 Multi-Tab Session

- [ ] Open 5 tabs to different URLs → all `navigate` calls succeed
- [ ] `read_page` on each tab → correct content per tab, no cross-contamination
- [ ] Close tab 3 → tabs 1, 2, 4, 5 remain functional
- [ ] Navigate tab 1 to a new URL → other tabs unaffected

### 6.3 Chrome Crash Recovery (Real-World)

- [ ] Navigate to a page, set cookies, fill a form (establish browser state)
- [ ] `kill -9 <chrome-pid>` to simulate Chrome crash
- [ ] Wait 10 seconds
- [ ] Next `navigate` call → Chrome relaunches, call succeeds within 30s
- [ ] Verify: previous cookies gone (expected — Chrome state lost on kill)
- [ ] Verify: server never hung during the entire sequence (all calls returned results)

### 6.4 Long-Running Session (1 Hour)

- [ ] Continuously call `navigate` + `read_page` every 30 seconds for 1 hour
- [ ] Success rate ≥ 99% (allow 1–2 transient failures maximum)
- [ ] Heap growth < 50MB over the hour
- [ ] No tool call hangs (every call returns within 120s)
- [ ] `/metrics` shows monotonically increasing `tool_calls_total` counter at end

### 6.5 Network Disruption Simulation

- [ ] Start automation, confirm tool calls succeeding
- [ ] Block Chrome's debug port (e.g. via `iptables` or process-level network isolation)
- [ ] Tool calls return errors — not hangs — within the configured timeout
- [ ] Unblock the port
- [ ] Next tool call succeeds (auto-reconnect restored normal operation)

### 6.6 HTTP Client Lifecycle

- [ ] Client A connects via HTTP, navigates to a site, sets a cookie
- [ ] Client A disconnects (TCP close / process kill)
- [ ] Server stays alive — verify via `curl http://localhost:9090/health`
- [ ] Client B connects via HTTP
- [ ] Client B reads the cookie set by Client A → cookie is present (browser state preserved across client sessions)
- [ ] Client B makes 10 tool calls → all succeed

### 6.7 Concurrent Clients

- [ ] 3 HTTP clients connect simultaneously
- [ ] Each client navigates to a different URL concurrently
- [ ] All 3 `read_page` calls return correct content — no mixing of tab content
- [ ] One client sends 50 rapid requests → rate limited gracefully (clean JSON-RPC rejections)
- [ ] The other 2 clients are unaffected by the flood (their calls still succeed)

### 6.8 Overnight Daemon (8 Hours)

- [ ] Start with `--http --auto-launch --server-mode`
- [ ] Send periodic tool calls every 5 minutes for 8 hours
- [ ] Kill Chrome at hour 2, hour 5 → auto-recovery observed both times (next call succeeds)
- [ ] Memory growth < 200MB over 8 hours
- [ ] Disk usage remains bounded (auto-prune has fired at least once, visible in `/health`)
- [ ] `/metrics` counters accurate at end of run
- [ ] Zero hangs across entire 8-hour run

### 6.9 Graceful Degradation

- [ ] Fill system memory to 80% → OpenChrome still serves requests (possibly slower, not hung)
- [ ] Create 1000+ checkpoint files in `~/.openchrome/` → disk monitor prunes automatically to configured limit
- [ ] Set `OPENCHROME_RATE_LIMIT_RPM=5`, run flood test → clean rate-limit rejections, no crashes
- [ ] Set `OPENCHROME_EVENT_LOOP_FATAL_MS=5000`, artificially block event loop for 6s → process exits with non-zero code

---

## 7. E2E Certification Tests (Follow-Up)

Automated versions of the real-world tests above. Implementation tracked separately.

| Test ID | Scenario | Automated? |
|---------|----------|------------|
| E2E-11 | WebSocket disconnect recovery | ❌ To implement |
| E2E-12 | Infinite reconnection (5 min Chrome down) | ❌ To implement |
| E2E-13 | HTTP transport independence (client disconnect) | ❌ To implement |
| E2E-14 | Multi-client HTTP concurrency | ❌ To implement |
| E2E-15 | Parallel tool call burst | ❌ To implement |
| E2E-16 | Rate limiter under flood | ❌ To implement |
| E2E-17 | Prometheus metrics accuracy | ❌ To implement |
| E2E-18 | Disk space auto-cleanup | ❌ To implement |
| E2E-19 | Event loop fatal recovery | ❌ To implement |
| E2E-20 | 72-hour endurance | ❌ To implement |
| E2E-21 | System pressure degradation | ❌ To implement |

See [E2E Certification Criteria](docs/roadmap/e2e-certification-criteria.md) for full test specifications.

---

## 8. Non-Goals

The following are explicitly out of scope for this initiative:

- Multi-step task orchestration (separate project — host AI agent's responsibility)
- AI agent lifecycle management (the host process manages its own agents)
- 24/7 uptime SLA guarantees (operator's infrastructure responsibility)
- Browser automation logic changes (tool behavior and semantics unchanged)
- Authentication/authorization for HTTP transport (future security initiative)
- Cross-machine session sharing (single-node scope only)

---

## 9. References

- [Implementation Plan](docs/roadmap/implementation-plan.md)
- [E2E Certification Criteria](docs/roadmap/e2e-certification-criteria.md)
- [MCP Streamable HTTP Spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- PR #392 — Phase 1: Streamable HTTP Transport
- PR #395 — Phase 2: Infinite Reconnection Mode
- PR #397 — Phase 3: Request Rate Limiter
- PR #398 — Phase 4: Production Safety Defaults
- PR #399 — Phase 5: Prometheus Metrics Export
- PR #400 — Phase 6: Deployment Infrastructure
- PR #402 — Phase 7: Disk Space Monitoring
