# TaskRun automatic session snapshots

Issue #1013 adds an opt-in continuity policy for long-running TaskRun workflows. The default remains unchanged: ordinary browser tools and TaskRun tools do not write session snapshots unless the caller explicitly enables the policy when starting a TaskRun.

## Enable the policy

Pass `auto_session_snapshot.enabled=true` to `oc_task_run_start`:

```json
{
  "goal": "Verify checkout flow across three pages",
  "success_criteria": ["Cart reviewed", "Order confirmation captured"],
  "auto_session_snapshot": {
    "enabled": true,
    "mode": "best-effort",
    "max_snapshots": 10
  }
}
```

Supported knobs:

- `enabled`: must be `true` to activate lifecycle snapshots.
- `mode`: `best-effort` by default. Snapshot failures are returned in metadata but do not fail the TaskRun tool call. `strict` rethrows snapshot failures after recording the error on the TaskRun.
- `max_snapshots`: number of snapshot ids retained on TaskRun metadata, clamped to `1..100`.

## Lifecycle triggers

When enabled, TaskRun lifecycle tools create compact `oc_session_snapshot` artifacts at these boundaries:

- `oc_task_run_start` → `auto-start`
- `oc_task_run_checkpoint` → `auto-retry`
- `oc_task_run_needs_help` → `auto-retry`
- `oc_task_run_complete` → `auto-final`

The snapshot memo is built from TaskRun metadata: goal, current progress/summary, completed items, success criteria or resume hint, and a compact TaskRun note. It does not include raw page content, screenshots, cookies, headers, or secrets.

## Resume behavior

`oc_session_resume` reads the latest snapshot or a specific snapshot id and reports objective, last step, completed steps, next actions, and live/remapped/closed tab status. TaskRun metadata also retains recent auto snapshot ids under `auto_session_snapshot_state.snapshot_ids` so hosts can choose a specific snapshot after compaction or reconnect.

## Failure handling and bounds

- Best-effort snapshot errors are recorded as `auto_session_snapshot_state.last_error` and an `auto_session_snapshot` event.
- Successful snapshots append an `auto_session_snapshot` event with the snapshot id.
- Retained ids are bounded by `max_snapshots`; the underlying `oc_session_snapshot` pruning still applies to snapshot files.
- Snapshot writes are additive and do not grant planning, replay, or browser-action authority.
