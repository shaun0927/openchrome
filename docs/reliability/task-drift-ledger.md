# Task drift ledger

OpenChrome can keep an opt-in, bounded task drift ledger for long-running browser work. Enable runtime hint recording with `OPENCHROME_TASK_LEDGER=1`.

The ledger is not a planner and does not call a model. It records compact session/tab-scoped tool outcomes so existing hints can tell the host when repeated attempts are drifting instead of making progress.

## Contract

Each ledger row contains:

- `sessionId` and optional `tabId`
- bounded `recentAttempts` with `toolName`, optional `action`/`target`, `outcome`, `reason`, and timestamp
- bounded `triedRecoveries` for Ralph/strategy attempts
- `driftSignals` such as `repeated_action`, `same_error`, `observation_loop`, `auth_loop`, `stale_ref_loop`, `timeout_loop`, and `visual_ambiguity`
- optional `suggestedNextStep` and `stopCondition`

Default responses are unchanged unless `OPENCHROME_TASK_LEDGER=1` is set and drift is detected. Debug output is explicit:

```json
{"includeLedger": true}
```

with `workflow_status` returns compact `taskLedger` rows for the current MCP session.

## Cleanup

The in-memory ledger is removed on `session:deleted` and per-tab rows are removed on `session:target-closed` / `session:target-removed`.
