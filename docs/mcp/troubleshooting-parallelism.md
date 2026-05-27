# Troubleshooting OpenChrome parallelism

## MCP disconnected or tools disappeared

1. From an MCP client, call `oc_doctor_report` and `oc_connection_health` — these expose the duplicate-controller signal and broker lifecycle directly through the MCP contract.

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

- Call `oc_doctor_report` (MCP) for a structured diagnostic snapshot, or `oc_connection_health` for the live controller topology and broker lifecycle state.
- Run `openchrome check --port 9222` to confirm Chrome is still reachable on that port (this is a bare Chrome ping, not a parallelism diagnostic).

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

Use the `oc_connection_health` MCP tool, or the optional `/health` HTTP endpoint when `--http` is enabled, to inspect controller topology and broker lifecycle. Both surfaces include sibling fields shaped like:

```json
{
  "controllerTopology": { "role": "owner" },
  "brokerLifecycle": {
    "mode": "broker-owner",
    "reconnectState": "idle",
    "activeLeases": 0
  }
}
```

`mode` is one of `direct`, `broker-owner`, or `broker-client`; `reconnectState` is one of `idle`, `reconnecting`, or `failed`.
