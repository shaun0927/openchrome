# `batch_execute` idempotency and inter-item waits

`batch_execute` keeps its default behavior unchanged when the new fields are
omitted. `failFast` remains the existing stop-on-first-failure flag; this change
does not rename or replace it.

## Per-item idempotency

Each task may include `idempotencyKey`:

```json
{
  "concurrency": 1,
  "tasks": [
    { "tabId": "page-1", "script": "window.stepA()", "idempotencyKey": "step-A" }
  ]
}
```

Successful results are cached in memory per MCP session. A later task with the
same key within the TTL returns the prior `BatchTaskResult` plus
`"skipped": "idempotent"` and does not execute the script again. Failed results
are not cached.

Configuration:

- `OPENCHROME_BATCH_IDEMPOTENCY_TTL_MS` — default 10 minutes.
- `OPENCHROME_BATCH_IDEMPOTENCY_MAX` — default 256 entries per session.

Eviction is TTL + LRU bounded. The cache is not persisted across processes or
shared across sessions.

## Inter-item waits

Sequential batches (`concurrency: 1`) may wait after an item before the next
sibling starts:

```json
{
  "concurrency": 1,
  "tasks": [
    {
      "tabId": "page-1",
      "script": "document.querySelector('button').click()",
      "interItemWaitFor": { "type": "function", "value": "window.__loaded === true" }
    },
    { "tabId": "page-1", "script": "document.body.innerText" }
  ]
}
```

`interItemWaitMs` provides a fixed delay. `interItemWaitFor` accepts the same
condition families as `wait_for`: `selector`, `selector_hidden`, `function`,
`navigation`, `url_match`, and `timeout`. Waits require `concurrency: 1`; higher
concurrency returns a structured `invalid_input` error before executing any item.

## Metrics

- `openchrome_batch_items_total{result="ok|err|skipped|failfast-skip"}`
- `openchrome_batch_idempotency_evictions_total{reason="ttl|lru"}`
