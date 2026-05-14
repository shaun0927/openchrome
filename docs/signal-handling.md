# Signal Handling in openchrome

This document describes how openchrome handles OS signals and process lifecycle events, with guidance for container and orchestrator deployments.

## SIGTERM — graceful shutdown

When openchrome receives `SIGTERM`, it:

1. Stops accepting new tool requests (in-flight requests are allowed to complete or time out).
2. Saves storage state (cookies, session data) to disk — guarded by a 5-second timeout so shutdown cannot stall indefinitely.
3. Sends `SIGTERM` to the Chrome process group (`kill -TERM -<pgid>`), then follows with a per-PID `SIGTERM`.
4. Exits with code `0`.

Chrome is launched with `detached: true` (its own process group) so a single `kill(pid)` would leave renderer, GPU, and crashpad children alive. The group kill ensures all Chrome subprocesses are cleaned up.

**Grace period**: the default Docker/systemd stop timeout is 10 seconds. For production use, extend it to at least 30 seconds to allow in-flight browser operations to drain cleanly.

## SIGINT — interactive interrupt

Handled identically to SIGTERM. Code `0` on clean exit.

## SIGHUP — Windows console close

On Windows, closing the console sends `CTRL_CLOSE_EVENT` which libuv maps to `SIGHUP`. openchrome registers a `SIGHUP` handler on Windows only. The OS force-kills the process ~5–10 seconds later regardless; shutdown is best-effort.

## `oc_stop` MCP tool semantics

The `oc_stop` tool triggers the same graceful shutdown path as SIGTERM. It is the recommended way for MCP clients (Claude, Codex, IDE integrations) to cleanly stop openchrome without sending OS signals directly.

After `oc_stop` completes:
- Storage state has been flushed to disk.
- Chrome has been sent SIGTERM.
- The MCP server responds with a final result before exiting.

## Docker deployment

```dockerfile
# Tell Docker to send SIGTERM directly to the process
STOPSIGNAL SIGTERM
```

Run with an extended stop timeout so Chrome cleanup completes before Docker force-kills:

```bash
docker run --stop-timeout 30 your-image openchrome serve --auto-launch --http=3100
```

Or with Docker Compose:

```yaml
services:
  openchrome:
    image: your-image
    command: openchrome serve --auto-launch --http=3100
    stop_grace_period: 30s
```

### Do not wrap in `npm run` or shell scripts

openchrome's `bin.openchrome` entry points directly to `dist/cli/index.js` with a `#!/usr/bin/env node` shebang. Node receives signals directly from the OS.

**Wrapping with `npm run` or a shell script interposes an extra process** that may not forward SIGTERM to Node. This means Chrome is not cleaned up and port leaks occur on restart.

```bash
# CORRECT — signals reach Node directly
CMD ["openchrome", "serve", "--auto-launch"]

# WRONG — npm swallows SIGTERM, Chrome leaks
CMD ["npm", "run", "start"]

# ALSO WRONG — shell interposes, SIGTERM lost
CMD ["/bin/sh", "-c", "openchrome serve"]
```

If you must use a shell entrypoint, use `exec` to replace the shell with Node:

```bash
#!/bin/sh
exec openchrome serve --auto-launch "$@"
```

## Kubernetes liveness vs readiness probes

openchrome exposes two HTTP probes (requires `--http` or `OPENCHROME_HEALTH_ENDPOINT=1`):

| Probe | Path | Returns 200 when |
|-------|------|-----------------|
| Liveness | `/health` | Process is alive and event loop is responsive |
| Readiness | `/ready` | Chrome is reachable, tools are registered, watchdogs have ticked |

Example Kubernetes deployment fragment:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 9090
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /ready
    port: 9090
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 6   # allow up to 30s for Chrome to start

lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 5"]   # allow load balancer to drain
```

Set `terminationGracePeriodSeconds: 30` on the Pod spec to match the `--stop-timeout 30` guidance above.

For an end-to-end local smoke test of `/ready` startup ordering and SIGTERM forwarding, run:

```bash
npm run build
scripts/verify/A6-ready-probe.sh
```

### `/ready` component states

`GET /ready` returns a JSON body with per-component states:

```json
{
  "ready": true,
  "components": {
    "chrome":    "ok",
    "tools":     "ok",
    "watchdogs": "ok"
  }
}
```

Component states: `"starting"` | `"ok"` | `"failing"`.

When `ready` is `false`, a `"blockers"` array lists the components that are not yet `ok`:

```json
{
  "ready": false,
  "components": { "chrome": "starting", "tools": "ok", "watchdogs": "ok" },
  "blockers": ["chrome"]
}
```

To relax the required set (e.g. accept traffic once Chrome is up even if tool registration is still completing):

```bash
OPENCHROME_READY_REQUIRES=chrome openchrome serve --auto-launch
```

Default required set: `chrome,tools,watchdogs`.

## Parent-process death watcher (stdio mode)

In `stdio` mode, openchrome monitors its parent PID every 2 seconds. If the parent disappears (IDE crash, `kill -9`), openchrome exits cleanly so Chrome is not left running as an orphan.

Disable with `OPENCHROME_PPID_WATCH=0` if you intentionally run openchrome as a daemon that outlives its launcher.
