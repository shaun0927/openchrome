# Safe OpenChrome parallelism

OpenChrome can drive many browser tasks in parallel, but the topology matters.

## Choose one topology

### 1. Broker owner with many clients (early)

Use one OpenChrome broker owner for a shared Chrome profile, then point MCP clients at that owner. The `--broker` flag publishes broker metadata that proxy clients discover by matching on `--port` and `--user-data-dir`; the `--http` port is what proxies actually connect through, so the owner must keep running while clients are attached.

Step 1 — start the broker owner once (keeps running):

```bash
openchrome serve --broker --auto-launch --http 3100 --port 9222 --user-data-dir ~/.openchrome/profiles/shared
```

Step 2 — register each MCP client as a stdio proxy with the same `--port` + `--user-data-dir`:

```bash
openchrome serve --connect-broker --port 9222 --user-data-dir ~/.openchrome/profiles/shared
```

This is the long-term shared-profile design: one direct CDP owner, many MCP clients. The broker owns browser lifecycle, leases, reconnect state, and per-target queues. Broker mode is implemented but still early — read the trust policy in [`docs/security/shared-profile-trust.md`](../security/shared-profile-trust.md) before sharing a profile across clients.

### 2. Independent direct MCP processes with isolated profiles

Use this today when you want several MCP clients without sharing a browser profile.

```bash
openchrome setup --client claude --port 9223 --user-data-dir ~/.openchrome/profiles/claude
openchrome setup --client codex --port 9224 --user-data-dir ~/.openchrome/profiles/codex
openchrome setup --client opencode --port 9225 --user-data-dir ~/.openchrome/profiles/opencode
```

Each process owns a different Chrome instance/profile, so direct CDP control does not conflict.

### 3. Unsafe: many direct MCP processes, one Chrome/profile

Avoid this:

```text
Claude -> openchrome serve --auto-launch --port 9222 --user-data-dir ~/.openchrome/profile
Codex  -> openchrome serve --auto-launch --port 9222 --user-data-dir ~/.openchrome/profile
```

Multiple direct controllers can race on target lifecycle, reconnect, cleanup, and tab ownership. Symptoms include missing MCP tools, `Target closed`, `CDPSession closed`, stale tabs, or unexpected Chrome shutdown.

## Client recipes

### Claude only

```bash
openchrome setup --client claude
```

Safe for one client. If another client will also run direct mode, add explicit `--port` and `--user-data-dir`.

### Codex only

```bash
openchrome setup --client codex
```

Remove stale `~/.codex/mcp.json` entries if you migrated to `~/.codex/config.toml`.

### Claude + Codex with isolated profiles

```bash
openchrome setup --client claude --port 9223 --user-data-dir ~/.openchrome/profiles/claude
openchrome setup --client codex --port 9224 --user-data-dir ~/.openchrome/profiles/codex
```

### Claude + Codex with shared broker

Step 1 — run one broker owner (keep this process running while clients are attached):

```bash
openchrome serve --broker --auto-launch --http 3100 --port 9222 --user-data-dir ~/.openchrome/profiles/shared
```

Step 2 — register both Claude and Codex with the stdio broker proxy command, using the same `--port` and `--user-data-dir` as the owner so they discover the same broker metadata:

```bash
openchrome serve --connect-broker --port 9222 --user-data-dir ~/.openchrome/profiles/shared
```

### OMX / Codex development

When developing OpenChrome itself while another assistant also uses OpenChrome, prefer isolated dev profiles:

```bash
openchrome setup --client codex --port 9322 --user-data-dir ~/.openchrome/profiles/openchrome-dev
```

### CI/headless

Use a disposable profile and a non-default port:

```bash
openchrome config --client codex --topology ci-headless
```

## Memory tradeoffs

A shared broker profile can reduce duplicate browser-process overhead, but each active tab can still create renderer, worker, GPU, and cache pressure. Shared Chrome is not a guarantee of flat memory usage. Use fewer active tabs, close unused leases, and prefer isolated CI profiles for reproducibility.
