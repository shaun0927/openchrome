# Recovery trajectory ledger

`RecoveryTrajectoryLedger` is passive recovery telemetry for #1017. It records compact attempt nodes for successful, failed, no-progress, aborted, and recovered tool calls so hosts can debug long browser runs after compaction or restart.

## Storage and toggle

- Default path from the MCP server: `.openchrome/recovery/trajectory.jsonl` under the current working directory.
- Disable with `OPENCHROME_RECOVERY_LEDGER=0`.
- Retention is bounded by:
  - `OPENCHROME_RECOVERY_LEDGER_MAX_NODES` (default 500)
  - `OPENCHROME_RECOVERY_LEDGER_MAX_NODE_BYTES` (default 4096)
  - `OPENCHROME_RECOVERY_LEDGER_MAX_FILE_BYTES` (default 512 KiB)

Writes are best-effort. A ledger write failure must not fail or delay the original tool call beyond a small bounded overhead.

## Node contract

Each node includes lightweight recovery facts only:

- `sessionId`, optional `workflowId`, optional `tabId`
- `nodeId`, optional `parentNodeId`
- `timestamp`
- `toolName`
- redacted/hashed `argsSummary`
- `resultStatus`: `success | error | no_progress | recovered | aborted`
- `progressStatus`: `progressing | stalling | stuck | unknown`
- optional `failureFingerprint`, `recoveryTool`, `evidenceHandle`, `observationSummary`, `reward`

The ledger does not store raw screenshots, full DOM, cookies, headers, or secrets. Large payload-like fields are hashed and secret-like fields are redacted.

## Safety boundary

The ledger is not a planner and not a replay system:

- It never executes browser actions.
- It never branches or searches by itself.
- It never restores external website side effects.
- #1018 may use ledger facts to rank advisory candidates.
- #1019 may attach deterministic reward scores.
- #1020 may consume records inside an explicitly bounded recovery runtime, but this ledger alone grants no execution authority.
- #1022 may aggregate outcomes for policy learning, but stored nodes remain telemetry.

## Verification anchors

Focused checks:

```bash
npm test -- tests/recovery/trajectory-ledger.test.ts --runInBand
npm run build
npm run lint:tier
```

Useful assertions in `tests/recovery/trajectory-ledger.test.ts` cover:

- success/error/recovered node chains and parent linkage;
- redaction and hashing of sensitive/large args;
- malformed JSONL line tolerance;
- result summary bounds and redaction;
- max-node retention;
- async write persistence and non-fatal write failures.
