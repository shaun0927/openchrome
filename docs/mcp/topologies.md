# OpenChrome MCP topologies

OpenChrome currently supports one safe direct-controller rule:

> Run at most one direct `openchrome serve --auto-launch` process for the same Chrome debug port and user-data directory.

Multiple MCP clients can still run in parallel today. When they need to share one Chrome user data directory, run a single broker owner (`openchrome serve --broker --auto-launch`) and point the other clients at it with `--connect-broker`; otherwise give each client its own isolated port and user-data directory.

## After upgrading OpenChrome

A package update only installs new OpenChrome code. It does **not** rewrite the
MCP server entries already registered in Claude Code, Codex CLI, OpenCode, or any
other host. Existing direct entries such as `openchrome serve --auto-launch` keep
using that direct topology until you change the host config.

If a release note says a new topology is required to avoid duplicate-controller
or opaque `-32000` startup failures:

1. update the package (`npm install -g openchrome-mcp@latest` or your package
   manager equivalent);
2. rerun `openchrome setup --client <host> ...` with the topology recommended by
   that release, or edit the host MCP config manually;
3. restart the MCP host session. Active sessions usually load their MCP tool
   namespace at startup and will not hot-reload a changed config.

Until an auto-elect topology is explicitly shipped and enabled by the release
notes, use either isolated per-client profiles or the explicit broker owner /
`--connect-broker` topology below. Maintainers can reuse the release-note wording
in [`docs/releases/action-required-config-migration.md`](../releases/action-required-config-migration.md)
when a release requires host config migration.

## Single-owner default

Use this when one MCP client owns OpenChrome on the default Chrome port/profile.

```bash
openchrome config --client codex
openchrome config --client claude
```

Generated configs use:

```bash
openchrome serve --auto-launch
```

Do not install this same direct config in multiple clients at the same time.

## Isolated per-client profiles

Use a different port and user-data directory for each client:

```bash
openchrome setup --client codex --port 9223 --user-data-dir ~/.openchrome/profiles/codex
openchrome setup --client claude --port 9224 --user-data-dir ~/.openchrome/profiles/claude
openchrome setup --client opencode --port 9225 --user-data-dir ~/.openchrome/profiles/opencode
```

Or use the built-in isolated preset as a starting point:

```bash
openchrome config --client codex --topology isolated
```

## CI/headless and development presets

For reproducible automation, prefer an isolated throwaway profile:

```bash
openchrome config --client codex --topology ci-headless
```

For local development, use a named development profile:

```bash
openchrome config --client claude --topology dev-profile
```

## Shared-profile broker trust model

Broker mode is the only supported way for more than one MCP client to share a
single Chrome user data directory. The broker process is the sole CDP owner for
that `(port, userDataDir)` pair; every other client must use `--connect-broker`
so it forwards stdio JSON-RPC over the broker's HTTP endpoint instead of opening
its own Chrome/CDP connection.

Use shared-profile broker mode only inside a **same-trust-zone**:

- all connected clients are operated by the same human or automation boundary;
- every client is allowed to see browser state that the shared Chrome profile can
  already see, including authenticated sites and open tabs;
- the broker HTTP endpoint remains loopback-only unless protected by an explicit
  bearer token or per-tenant API-key/JWT configuration;
- untrusted or third-party agents use an isolated `--user-data-dir`, separate
  debug port, or a separate broker.

Do not mix trusted and untrusted MCP clients on one shared profile. The lease and
queue diagnostics are structural by design: they may show session, worker, lane,
target, and queue counters, but they must not expose URL, title, cookie,
screenshot, DOM, or extracted page payloads across tenant boundaries.

### Client recipes

**Claude + Codex against one trusted browser**

```bash
# Terminal 1: the single Chrome/CDP owner
openchrome serve --broker --auto-launch --http 3100 --port 9222 \
  --user-data-dir ~/.openchrome/shared-profile

# Terminal 2+: stdio MCP clients. When the broker has an auth token, share it
# via OPENCHROME_AUTH_TOKEN (the proxy auto-discovers the broker's authTokenEnv
# hint and uses that bearer for every forwarded JSON-RPC request).
openchrome serve --connect-broker --port 9222 \
  --user-data-dir ~/.openchrome/shared-profile

openchrome serve --connect-broker --port 9222 \
  --user-data-dir ~/.openchrome/shared-profile
```

**OMX / local agent swarm**

Run the broker once in a durable pane, then configure each worker/client entry to
use `--connect-broker --port <broker-port> --user-data-dir <broker-profile>`. Do
not let worker panes start direct `openchrome serve --auto-launch` processes
against the same profile.

**CI**

Prefer `openchrome config --client codex --topology ci-headless` or isolated
profiles per job. Use broker mode in CI only when the job intentionally tests
multi-client shared-profile behavior.

### Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Duplicate-controller error on startup | A client started direct mode against the shared profile | Stop the direct client and restart it with `--connect-broker`, or migrate that host to an isolated port/profile. If you just upgraded OpenChrome, rerun setup or edit the host config; the package update did not change the existing registration. |
| `No broker metadata found` | Broker owner is not running or profile/port do not match | Start the broker with the same `--port` and `--user-data-dir`. |
| A client lost connection but Chrome stayed open | Expected proxy disconnect behavior | Reconnect the stdio proxy; do not start a second direct owner. |
| Cross-tenant resource denial | The MCP session is bound to a different tenant | Use the matching tenant credentials or an isolated profile. |
| Memory pressure from too many tabs | Shared profile accumulates all clients' tabs | Close unused sessions/tabs or split clients across isolated profiles. |
