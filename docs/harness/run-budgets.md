# Run harness wandering budgets

`oc_run_start` and `oc_run_status` accept an optional `budget` object for opt-in run-level wandering guards. A budget supplied at start is persisted on the run and reused by later `oc_run_status` calls; a status-call budget can still override it for one check. When omitted everywhere, run status remains the existing hint-only ledger behavior.

Supported budget keys:

- `max_tool_calls`
- `max_same_tool_retries`
- `max_observation_only_calls`
- `max_no_progress_streak`
- `max_wall_ms`

When a budget is exceeded, OpenChrome records a `run_finished` event, marks the run `needs_strategy_change`, attaches a deterministic failure category (`MAX_STEPS_EXCEEDED`, `NO_PROGRESS`, or `LLM_WANDERING`), and returns a suggested next step. Batch tools such as `batch_execute`, `batch_paginate`, and crawl/task polling tools are exempt from same-tool retry counting to avoid blocking intentional batch workflows.


Example:

```json
{
  "run_id": "checkout-smoke",
  "budget": {
    "max_same_tool_retries": 2,
    "max_no_progress_streak": 3,
    "max_wall_ms": 60000
  }
}
```

After starting with this payload, callers can pass only `{ "run_id": "checkout-smoke" }` to `oc_run_status`; the stored budget is evaluated automatically.
