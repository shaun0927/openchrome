# Troubleshooting OpenChrome parallelism

## MCP disconnected or tools disappeared

1. Run diagnostics:

   ```bash
   openchrome doctor --check duplicate-controllers
   ```

2. Check running OpenChrome processes:

   ```bash
   ps aux | grep openchrome-mcp
   ```

3. If several processes target the same port/profile, either stop the extra client cleanly or move clients to explicit isolated ports/profiles.

Avoid broad `pkill` commands unless you have confirmed the processes are disposable.

## `Target closed` or `CDPSession closed`

Likely causes:

- another direct controller closed or detached the tab;
- Chrome restarted while a client still held stale target IDs;
- memory-pressure cleanup closed an unleased tab;
- stale client config launched a second OpenChrome copy.

Safe next steps:

```bash
openchrome doctor --json
openchrome check --port 9222
```

Then restart only the affected MCP client or switch it to `--connect-broker` / isolated profile mode.

## Multiple `openchrome-mcp` installs

Mixed global and `npm exec openchrome-mcp@latest` registrations can launch different binaries against the same Chrome. Prefer generated configs from:

```bash
openchrome setup --client codex
openchrome setup --client claude
```

## Stale Codex `mcp.json`

Codex now uses `~/.codex/config.toml`. If `~/.codex/mcp.json` still contains OpenChrome, remove or archive that stale entry after confirming `config.toml` has the intended server.

## Broker health checks

Use `oc_connection_health` and the optional `/health` endpoint to inspect:

- `controllerTopology.role`
- `brokerLifecycle.mode`
- `brokerLifecycle.reconnectState`
- `brokerLifecycle.activeLeases`
