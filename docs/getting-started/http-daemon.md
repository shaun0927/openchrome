# HTTP Daemon Mode

OpenChrome's HTTP transport turns the MCP server into a long-running daemon that
multiple callers can reach concurrently over plain HTTP + JSON-RPC. This page is
the single reference for operators who need a shared, persistent OpenChrome
instance — for CI pipelines, multi-client setups, or dashboard integrations.

For the 30-second quick-start, jump to [Copy-pasteable curl recipe](#copy-pasteable-curl-recipe).

---

## 1. When to choose stdio vs http vs both

| Situation | Recommended transport | Reason |
|-----------|----------------------|--------|
| Single MCP client launches the process and controls its lifetime (Claude Code, Claude Desktop, Cursor, etc.) | `stdio` (default) | Simplest path; process exits with the client; PPID watcher guards against orphans. |
| Long-running daemon shared by **multiple** MCP clients, CI jobs, or callers on different hosts | `http` | One process, many concurrent connections; idle-timeout controls self-exit; no parent dependency. |
| MCP client launches the process **and** a sidecar (dashboard, monitoring script) needs to poll `/health` or `/metrics` | `both` | stdio carries MCP traffic; HTTP carries health/metrics side-channel; no second process needed. |

**Rule of thumb**: if you ever use `npx openchrome serve` in a `Procfile`, a
`systemd` unit, a Docker `CMD`, or a CI step that outlives a single test run,
reach for `--transport http`.

---

## 2. Flag and environment-variable reference

All flags live in `src/index.ts`. Every env var listed here is read in the same file.

### Transport selection

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--http [port]` | `OPENCHROME_HTTP_PORT` | `3100` | Enable HTTP transport. Implies `--transport http` unless `--transport both` is also set. Port defaults to `3100` when the flag is present without a value. |
| `--http-host <host>` | `OPENCHROME_HTTP_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only with a bearer token; the server refuses to start with a non-loopback host and no auth (see [Security model](#4-security-model)). |
| `--transport <mode>` | `OPENCHROME_TRANSPORT` | `stdio` | Explicit transport override. Accepted values: `stdio`, `http`, `both`. Takes precedence over `--http`. |

### Authentication

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--auth-token <token>` | `OPENCHROME_AUTH_TOKEN` | — | Bearer token required on every `/mcp` request. Must be set unless `--allow-unauthenticated-http` is explicitly provided. |
| `--allow-unauthenticated-http` | `OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP=1` | `false` | Allow unauthenticated connections **only** when `--http-host` is loopback (`127.0.0.1` / `::1`). The server refuses to start if the bind address is non-loopback and this flag is set without a token. |

### Lifecycle

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--idle-timeout <duration>` | `OPENCHROME_IDLE_TIMEOUT_MS` | disabled | Self-exit (code 0) after the specified idle window with zero active sessions. Format: `<number>(ms\|s\|m\|h)` — e.g. `30m`, `90s`, `500ms`. Bare integers are rejected. Env var takes an integer number of milliseconds. Has **no effect** when transport is `stdio` (PPID watcher governs lifecycle there). |

### Health and monitoring

| Flag / env var | Default | Description |
|----------------|---------|-------------|
| `OPENCHROME_HEALTH_ENDPOINT` | on for `http`/`both`, off for `stdio` | Force-enable (`1`/`true`) or force-disable (`0`/`false`) the `/health` and `/metrics` HTTP listener. Invalid values fall through to the transport-mode default. |
| `OPENCHROME_HEALTH_PORT` | `3101` (separate from MCP port) | Port for the standalone health endpoint when it is enabled in stdio mode. In `http`/`both` mode the health routes are served on the same port as `/mcp`. |
| `OPENCHROME_HEALTH_BIND` | `127.0.0.1` | Bind address for the standalone health endpoint. |

### Parent-process watcher

| Env var | Default | Description |
|---------|---------|-------------|
| `OPENCHROME_PPID_WATCH` | enabled | Set to `0` to disable the parent-process watcher **in stdio mode**. This setting is a no-op for `--transport http` and `--transport both` — those modes are daemon-capable and intentionally do not track a parent process. |
| `OPENCHROME_PPID_WATCH_INTERVAL_MS` | `2000` | Polling interval in ms for the parent watcher. Clamped to `[500, 60000]`. Ignored in HTTP/both modes. |

### Flag interaction rules (explicit)

1. `--http` implies `--transport http` **unless** `--transport both` is also set (or `OPENCHROME_TRANSPORT=both`).
2. `--auth-token` is **required** unless `--allow-unauthenticated-http` is explicitly provided. Omitting both causes an error at startup.
3. `--allow-unauthenticated-http` is only accepted when `--http-host` resolves to a loopback address (`127.0.0.1` or `::1`). A non-loopback bind address with no auth token causes an immediate startup error.
4. `--idle-timeout` is ignored in `stdio` mode. PPID watcher governs process lifetime there.
5. `OPENCHROME_PPID_WATCH=0` has no effect when transport is `http` or `both`.
6. `OPENCHROME_HEALTH_ENDPOINT` defaults to **on** for `http`/`both`, **off** for `stdio`.

---

## 3. Multi-client scenario

Two MCP clients share one OpenChrome daemon. Each client issues independent
`tools/list` and `tools/call` requests; the daemon multiplexes them over separate
HTTP sessions.

```
┌─────────────────────┐        HTTP + JSON-RPC       ┌──────────────────────────┐
│  MCP Client A       │ ────────────────────────────► │                          │
│  (Claude Code)      │                               │  openchrome daemon       │
└─────────────────────┘                               │  --transport http        │
                                                      │  --http 3100             │
┌─────────────────────┐        HTTP + JSON-RPC        │  --auth-token <token>    │
│  MCP Client B       │ ────────────────────────────► │                          │
│  (CI pipeline)      │                               │  GET /health → 200 OK    │
└─────────────────────┘                               │  GET /metrics → JSON     │
                                                      │  GET /api/tool-calls     │
┌─────────────────────┐        GET /health            │                          │
│  Dashboard / probe  │ ────────────────────────────► │                          │
└─────────────────────┘                               └──────────────────────────┘
                                                                  │
                                                              CDP / DevTools
                                                                  │
                                                       ┌──────────▼──────────┐
                                                       │    Chrome process   │
                                                       └─────────────────────┘
```

Key properties of this setup:
- **Single Chrome process**: all sessions share one browser; tabs are isolated per session.
- **Concurrent requests**: the HTTP server handles multiple in-flight MCP requests.
- **Independent lifecycles**: clients can connect and disconnect without restarting the daemon.
- **Idle-timeout**: when all clients disconnect and no new sessions arrive within the idle window, the daemon exits cleanly (code 0).

---

## 4. Security model

- **Bearer-token auth** (`--auth-token`): every request to `/mcp` must include
  `Authorization: Bearer <token>`. Requests without a valid token receive `401 Unauthorized`.
- **Loopback-only default**: `--http-host` defaults to `127.0.0.1`. External
  access requires explicitly setting `--http-host 0.0.0.0` (or another
  non-loopback address) **and** providing `--auth-token`.
- **Unauthenticated rejection rule**: if `--allow-unauthenticated-http` is set
  and `--http-host` is non-loopback, the server refuses to start with an error.
  This prevents accidentally exposing an unauthenticated HTTP endpoint to the
  network.
- **`/health` and `/metrics` endpoints**: these routes are **always
  unauthenticated** (no bearer token required). They are bound to the same
  address as `/mcp` — keep the bind address loopback unless you explicitly want
  external health probes.
- **`/api/tool-calls` and other dashboard endpoints**: these require the same
  bearer token as `/mcp`.
- **Rate limiting**: the HTTP transport applies a per-session rate limiter (see
  `src/transports/http.ts`). Excessive requests are throttled with `429 Too Many Requests`.

---

## 5. Copy-pasteable curl recipe

### Step 1 — Start the daemon

```bash
# macOS / Linux
npx openchrome serve \
  --http 3100 \
  --auth-token mysecrettoken \
  --idle-timeout 30m
```

```powershell
# Windows (PowerShell)
npx openchrome serve `
  --http 3100 `
  --auth-token mysecrettoken `
  --idle-timeout 30m
```

The daemon logs startup to stderr and listens on `http://127.0.0.1:3100`.

### Step 2 — Hit `/health`

```bash
# macOS / Linux
curl -s http://127.0.0.1:3100/health
```

```powershell
# Windows (PowerShell)
Invoke-RestMethod -Uri http://127.0.0.1:3100/health
```

Expected response shape:

```json
{
  "status": "ok",
  "uptime": 12.3
}
```

`/health` is always unauthenticated. A `"status": "ok"` response means the
daemon is up and accepting connections.

### Step 3 — Send an MCP `tools/list` request

```bash
# macOS / Linux
curl -s \
  -X POST http://127.0.0.1:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mysecrettoken" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

```powershell
# Windows (PowerShell)
Invoke-RestMethod `
  -Method POST `
  -Uri http://127.0.0.1:3100/mcp `
  -Headers @{ "Content-Type" = "application/json"; "Authorization" = "Bearer mysecrettoken" } `
  -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expected response shape (abbreviated):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      { "name": "navigate", "description": "..." },
      { "name": "read_page", "description": "..." }
    ]
  }
}
```

The `tools` array will contain at least one entry. Substitute `mysecrettoken`
with the token you passed to `--auth-token`, and `3100` with your chosen port.

---

## 6. Idle-timeout behaviour

The `--idle-timeout` flag causes the daemon to exit cleanly after a configurable
window of zero active sessions.

```bash
# Start with a 90-second idle timeout
npx openchrome serve \
  --http 3100 \
  --auth-token mysecrettoken \
  --idle-timeout 90s
```

After the last session closes (or if no session was ever opened), the daemon
monitors for inactivity. Once 90 seconds pass with zero sessions, it logs a
shutdown message to stderr and exits with code 0.

To observe this:

```bash
# 1. Start the daemon in a background shell or tmux pane
npx openchrome serve --http 3100 --auth-token mysecrettoken --idle-timeout 90s &

# 2. Wait 90+ seconds without sending any MCP request

# 3. Confirm the process has exited (macOS / Linux)
pgrep -f 'openchrome.*--http 3100' && echo "still running" || echo "exited (idle-timeout fired)"
```

```powershell
# Windows equivalent
Get-Process | Where-Object { $_.MainWindowTitle -like '*openchrome*' }
```

Notes:
- Idle-timeout is **disabled by default**. Omit the flag for a daemon that runs until explicitly stopped.
- `OPENCHROME_IDLE_TIMEOUT_MS` accepts the same duration as an integer number of milliseconds (e.g. `90000` for 90 s).
- Idle-timeout is ignored in `stdio` mode; PPID watcher handles process lifetime there.

---

## 7. Dashboard endpoint

When running with `--transport http` or `--transport both`, the daemon serves a
read-only dashboard API on the same port:

| Endpoint | Auth required | Description |
|----------|---------------|-------------|
| `GET /health` | No | Liveness check. Returns `{"status":"ok","uptime":<seconds>}`. |
| `GET /metrics` | No | Server metrics snapshot (uptime, session counts, tool-call totals). |
| `GET /api/tool-calls` | Yes (bearer token) | Recent tool-call log from dashboard state. |

Example — fetch metrics:

```bash
curl -s http://127.0.0.1:3100/metrics
```

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3100/metrics
```

The desktop dashboard (if installed) reads the same endpoints. External
monitoring probes (Prometheus, Uptime Robot, etc.) can poll `/health` without
credentials.

---

## 8. Troubleshooting

### I get `401 Unauthorized` with no token

**Expected behaviour.** Every `/mcp` request requires `Authorization: Bearer <token>`.
Either pass `--auth-token <token>` when starting the daemon **and** include the
matching header in your request, or start the daemon with
`--allow-unauthenticated-http` (loopback only — see [Security model](#4-security-model)).

### The daemon does not exit when its parent process dies

**Expected behaviour** for `--transport http`. The daemon is designed to outlive
its launching process. Use `--idle-timeout` to configure self-exit after
inactivity, or stop the daemon explicitly:

```bash
# macOS / Linux — stop via MCP tool
# (if you have an MCP client connected)
# Use the oc_stop tool from your MCP client.

# Or kill by process pattern
pkill -f 'openchrome.*--http 3100'
```

```powershell
# Windows
Get-Process node | Where-Object CommandLine -like '*openchrome*--http*3100*' | Stop-Process
```

### Port already in use (`EADDRINUSE`)

A prior daemon is still running on the same port. Options:

```bash
# Option A: stop the old daemon gracefully (macOS / Linux)
pkill -f 'openchrome.*--http 3100'

# Option B: pick a different port
npx openchrome serve --http 3200 --auth-token mysecrettoken
```

```powershell
# Windows: find which process owns the port
netstat -ano | findstr :3100
# then: Stop-Process -Id <PID>
```

### The server refuses to start with an auth/host error

If you see an error about `unauthenticated` or `non-loopback`, you have
provided `--allow-unauthenticated-http` with a non-loopback `--http-host`.
Either add `--auth-token` or keep `--http-host 127.0.0.1` (the default).

---

## See also

- [README — Environment variables](../../README.md#environment-variables): full
  table of `OPENCHROME_PPID_WATCH`, `OPENCHROME_HEALTH_ENDPOINT`, and related
  vars.
- [Architecture overview](../architecture.md): transport layer in context.
- `src/transports/http.ts`: HTTP transport implementation, rate limiter, auth middleware.
- `src/index.ts`: all CLI flag definitions (lines 92–97).
