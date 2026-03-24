# Reliability Guarantee Initiative: OpenChrome Never Hangs

## Motivation

OpenChrome controls Chrome from AI agents via CDP. In practice this means it runs in
long-lived daemon processes — started by an orchestrator, left alive for hours, expected to
serve tool calls on demand at any moment. That runtime profile is fundamentally different from
a typical short-lived CLI or a request/response web service.

The failure modes that matter in this context are not crashes (Chrome already has a process
supervisor) but **hangs and silent wedges**: a tool call that never returns, a WebSocket that
looks alive but is not, a reconnect loop capped at 5 attempts that quietly gives up at 2 AM.
When OpenChrome hangs, the AI agent stalls. When the agent stalls, the user sees nothing —
no error, no retry, no explanation.

The industry has converged on a three-tier resilience pattern for long-lived infrastructure
daemons:

1. **Transport resilience** — the server survives host-process restarts without losing state
2. **Connection resilience** — the server heals broken downstream connections automatically
3. **Operational visibility** — operators can observe health metrics and set capacity limits

OpenChrome already has a strong 4-layer self-healing architecture (CDP connection resilience,
session state persistence, Chrome process supervision, application watchdog). The layers are
solid individually. What is missing is the glue that makes them work together as a coherent
production-grade daemon:

- The server is still bound to its host process via stdio (no HTTP transport)
- Reconnection attempts are capped at 5 (fine for interactive use, fatal for overnight runs)
- There are no rate limits (a runaway agent can saturate the event loop)
- The event-loop watchdog is disabled by default in production builds
- Domain memory uses synchronous I/O that blocks the event loop under load
- There are no Prometheus metrics (operators are flying blind)
- There are no deployment artifacts (no systemd unit, no Docker Compose, no PM2 config)
- Disk usage is unbounded (journals and snapshots accumulate forever)

This initiative closes all of those gaps in a single tracked effort.

---

## Philosophy

> **Every tool call MUST return a result — success or error — within the timeout.**
> OpenChrome never hangs. If connections break, it self-heals. If Chrome dies, it restarts.
> Then it waits for the next call.

This is the reliability contract. It is narrow and precise by design. OpenChrome does not
promise to complete multi-step tasks, manage AI agent lifecycles, or guarantee 24/7 uptime
against arbitrary host failures. It promises exactly one thing: **any call that enters
OpenChrome will exit OpenChrome**.

---

## Responsibility Boundary

| Concern | Owner |
|---|---|
| Per-tool-call guarantee (always respond, never hang) | **OpenChrome** |
| Server-level resilience (stay alive, self-heal connections and Chrome) | **OpenChrome** |
| Browser and session state preservation across restarts | **OpenChrome** |
| Multi-step task orchestration and retry logic | Orchestrator / separate project |
| AI agent lifecycle management | Host process / orchestration layer |
| 24/7 scheduling, cron, SLA monitoring | Infrastructure operator |

OpenChrome is a tool server, not a task runner. It accepts calls, executes them, and returns
results. What the agent does between calls is not OpenChrome's concern.

---

## Scope

This master issue tracks eight implementation sub-tasks and one certification sub-task, grouped
into two natural delivery milestones:

**Milestone A — Core Daemon Hardening** (Phases 1–4): The changes that make OpenChrome safe
to leave running unattended. Must ship together; each phase is a prerequisite for the next in
terms of testability.

**Milestone B — Operational Excellence** (Phases 5–8): The changes that make OpenChrome
observable and maintainable in production. Can ship incrementally after Milestone A.

---

## Sub-tasks

### Phase 1 — Streamable HTTP Transport
- [ ] **Add MCP Streamable HTTP transport alongside existing stdio**

  OpenChrome currently dies when its host process closes stdin. Adding the Streamable HTTP
  transport (MCP spec 2025-03-26) decouples the server from host-process lifecycle: the server
  starts with `openchrome serve --http 3100`, binds a port, and keeps running across agent
  restarts. The TypeScript MCP SDK v1.10.0+ ships `StreamableHTTPServerTransport` out of the
  box.

  Key files: `src/mcp-server.ts`, `src/index.ts`, new `src/transports/http.ts`

  Complexity: **Medium** — new transport class, CLI flag, graceful shutdown hook, session
  cookie handling for multi-client scenarios.

  Sub-issue: #TBD

---

### Phase 2 — Infinite Reconnection Mode
- [ ] **Change CDPClient reconnection from max-5-attempts to configurable (default: Infinity in HTTP mode)**

  `CDPClient.handleDisconnect()` (src/cdp/client.ts lines 458–466) caps reconnect attempts at
  5 with a 30-second backoff ceiling. For interactive stdio sessions this is reasonable. For a
  daemon left running overnight it is a silent failure. In HTTP mode the default should be
  `Infinity` with a 60-second backoff cap. Reconnection status must be surfaced via the
  `/health` endpoint and the `connection_health` tool so operators and agents can observe it.

  Key files: `src/cdp/client.ts`, `src/watchdog/health-endpoint.ts`

  Complexity: **Low** — config change, backoff cap update, health endpoint field addition.

  Sub-issue: #TBD

---

### Phase 3 — Request Rate Limiter
- [ ] **Add a token-bucket per-session rate limiter (default: 60 req/min)**

  A runaway agent or a tight orchestration loop can saturate the Node.js event loop before
  the watchdog fires. A token-bucket rate limiter at the MCP server layer provides a first line
  of defence. Requests that exceed the limit receive a graceful rejection with a
  `retry-after` hint rather than timing out silently. The limit must be configurable via
  environment variable (`OPENCHROME_RATE_LIMIT_RPM`).

  Key files: `src/mcp-server.ts`

  Complexity: **Low-Medium** — token bucket implementation (or lightweight dependency),
  rejection response format, per-session vs global policy decision.

  Sub-issue: #TBD

---

### Phase 4 — Production Defaults for Event-Loop Watchdog
- [ ] **Enable the event-loop fatal threshold by default in production**

  `src/watchdog/event-loop-monitor.ts` implements event-loop lag detection but the fatal
  threshold is disabled by default. A 30-second threshold (`OPENCHROME_EVENT_LOOP_FATAL_MS=30000`)
  is a safe production default: anything lagging that long is already causing tool call
  timeouts. The environment variable should be documented and the default written into
  `src/config/defaults.ts` with `NODE_ENV=production` gating.

  Key files: `src/config/defaults.ts`, `src/watchdog/event-loop-monitor.ts`

  Complexity: **Low** — config wiring and environment-variable gating.

  Sub-issue: #TBD

---

### Phase 5 — Async Domain Memory I/O
- [ ] **Replace synchronous file I/O in domain memory with `fs.promises`**

  `src/memory/domain-memory.ts` uses `writeFileSync` / `readFileSync`. These calls block the
  Node.js event loop for the duration of the disk operation. Under concurrent tool calls or
  on slow network-attached storage this causes measurable latency spikes that can cascade into
  event-loop lag alerts. Replacing them with `async/await` + `fs.promises` eliminates the
  blocking entirely. Existing tests must be updated to `await` the new async signatures.

  Key files: `src/memory/domain-memory.ts`

  Complexity: **Low** — mechanical async conversion; watch for callers that are not yet async.

  Sub-issue: #TBD

---

### Phase 6 — Prometheus Metrics Export
- [ ] **Add `/metrics` endpoint exposing structured operational telemetry**

  Operators running OpenChrome in production need time-series data to detect degradation
  before it becomes an outage. The existing `/health` endpoint returns a point-in-time
  snapshot; it cannot drive alerting rules or dashboards. A `/metrics` endpoint in Prometheus
  text format enables standard scraping by Prometheus, Grafana, Datadog, and similar tools.

  Metrics to expose:
  - `openchrome_reconnect_total` — CDP reconnect attempt counter (labels: outcome)
  - `openchrome_tool_duration_seconds` — histogram of tool call durations (labels: tool_name)
  - `openchrome_heap_bytes` — Node.js heap usage gauge
  - `openchrome_active_sessions` — current session count gauge
  - `openchrome_tab_health` — gauge per health state (healthy / degraded / crashed)

  Key files: `src/watchdog/health-endpoint.ts`

  Complexity: **Medium** — metric collection points across multiple modules, dependency on
  `prom-client` or equivalent, instrumentation at call sites.

  Sub-issue: #TBD

---

### Phase 7 — Deployment Infrastructure
- [ ] **Provide systemd unit, Docker Compose, and PM2 ecosystem file**

  OpenChrome is production-ready at the code level but ships no deployment artifacts. Users
  who want to run it as a system daemon must write their own init configuration. Three
  artifacts cover the most common deployment targets:

  - `deploy/openchrome.service` — systemd unit with `Restart=always`, `RestartSec=5`,
    `MemoryMax=512M`, and environment-file support
  - `deploy/docker-compose.yml` — single-service Compose file with `healthcheck` pointing
    at the `/health` endpoint and a named volume for `~/.openchrome`
  - `deploy/ecosystem.config.js` — PM2 ecosystem file for Node.js-native process management

  Key files: new `deploy/` directory

  Complexity: **Low** — configuration authoring, no code changes required.

  Sub-issue: #TBD

---

### Phase 8 — Disk Space Monitoring and Auto-Pruning
- [ ] **Monitor `~/.openchrome/` size; auto-prune old journals, snapshots, and checkpoints**

  AI agent continuity tools (checkpoint, snapshot, journal) write to `~/.openchrome/` without
  any retention policy. On a server running multiple agents this directory can grow to
  gigabytes over weeks. The server should:

  - Track directory size at startup and on a configurable interval
  - Warn at 90% of a configurable threshold (default: 1 GB)
  - Auto-prune: journals older than 7 days, snapshots older than 30 days, checkpoints
    beyond the most recent 10
  - Expose current disk usage in the `/health` and `/metrics` endpoints

  Key files: `src/config/defaults.ts`, new `src/watchdog/disk-monitor.ts`

  Complexity: **Low-Medium** — async directory walk, age-based deletion, configuration
  surface, health endpoint integration.

  Sub-issue: #TBD

---

### Phase 9 — E2E Reliability Certification Suite
- [ ] **Implement an end-to-end test harness that certifies the reliability guarantee**

  Unit tests verify individual layers in isolation. The reliability guarantee is a
  system-level property: it only holds when all layers interact correctly under adversarial
  conditions. The certification suite must simulate the failure modes that matter in
  production and assert that OpenChrome recovers without hanging:

  - CDP WebSocket drops mid-call → tool call must return an error, not hang
  - Chrome process killed externally → supervisor relaunches, subsequent calls succeed
  - Event-loop blocked for >threshold → watchdog fires, process exits cleanly (not hangs)
  - 1000 sequential tool calls with no Chrome restart → zero hangs, P99 latency within SLA
  - Rate limit burst → excess calls rejected with retry-after, no crash
  - Disk near threshold → warning surfaced, auto-prune fires, server keeps running

  The suite produces a pass/fail certificate that can be attached to releases as a
  reproducible evidence artifact.

  Sub-issue: #TBD

---

## Success Criteria

This initiative is complete when the E2E Reliability Certification Suite (Phase 9) passes
against a build that includes all eight implementation phases. Specifically:

- [ ] All certification scenarios pass with zero hangs observed
- [ ] P99 tool call latency is within the configured timeout under all simulated failure conditions
- [ ] `/health` endpoint returns structured status for all self-healing layers
- [ ] `/metrics` endpoint is scrapable by a standard Prometheus instance
- [ ] Deployment artifacts boot a working daemon from a clean environment in under 60 seconds
- [ ] Disk usage remains bounded after 72 hours of simulated agent activity

---

## Non-Goals

The following are explicitly out of scope for this initiative:

- **Multi-step task orchestration.** Deciding what sequence of tool calls to make, retrying
  failed sequences, and managing task state across calls is the orchestrator's responsibility.
  OpenChrome executes individual tool calls; it does not plan or retry workflows.

- **AI agent lifecycle management.** Starting, stopping, and supervising the AI agent process
  that calls OpenChrome is the host's responsibility. OpenChrome does not manage its callers.

- **24/7 uptime SLA guarantees.** OpenChrome provides best-effort self-healing within a single
  process. Host-level redundancy (multiple instances, load balancing, geographic failover) is
  the infrastructure operator's responsibility.

- **Browser automation logic changes.** The reliability initiative covers transport,
  connection, and operational layers only. Changes to how specific tools interact with
  Chrome are out of scope.

- **Authentication and authorization.** The HTTP transport added in Phase 1 will be
  localhost-only by default. Full auth is a separate security initiative.

---

## References

- MCP Streamable HTTP Transport specification (2025-03-26):
  https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- TypeScript MCP SDK `StreamableHTTPServerTransport`:
  https://github.com/modelcontextprotocol/typescript-sdk
- Chrome DevTools Protocol WebSocket connection lifecycle:
  https://chromedevtools.github.io/devtools-protocol/
- Prometheus client for Node.js (`prom-client`):
  https://github.com/siimon/prom-client
- Node.js `fs.promises` API:
  https://nodejs.org/api/fs.html#fspromisesapi
- systemd service unit documentation:
  https://www.freedesktop.org/software/systemd/man/systemd.service.html
