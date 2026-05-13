# Long-task run events

The run harness provides an opt-in, pollable event ledger for browser workflows
that can outlive a single short interaction. Start a run with `oc_run_start`,
pass the returned `run_id` (or `runId`) to supported tool calls, and poll
`oc_run_status` / `oc_run_events` or the equivalent URI
`openchrome://runs/<run_id>` shown in status responses.

Default tool behavior remains synchronous: callers still receive the normal MCP
result from `execute_plan`, `crawl`, `crawl_sitemap`, `batch_paginate`, and
`batch_execute`. When those long-task tools include a run id, OpenChrome also
writes bounded ledger events:

- `run_started` from `oc_run_start`.
- `tool_call_started` with a redacted stable argument hash.
- `progress` with `metadata.stage: "started"` before the long task runs.
- `tool_call_finished` when the synchronous tool returns.
- `partial_result` for a normal/error MCP response, or `warning` when the tool
  throws through the server error path.
- `run_finished` only when the caller explicitly calls `oc_run_finish`, or when
  `oc_run_status` marks a budget breach as `needs_strategy_change`.

Retention is bounded. Run records are stored under `~/.openchrome/runs` by
default and pruned to `OPENCHROME_RUN_MAX_RECORDS` records (default `500`).
Cleanup removes older terminal records first and preserves active runs.

The ledger is best-effort observability only: it performs no LLM calls, does not
make tools asynchronous by default, and never changes the underlying tool result
if event persistence fails.
