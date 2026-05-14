# `wait_for` function-mode controls

`wait_for` already supports `type: "function"` for a JavaScript predicate in the
current page. The function predicate is evaluated in the current main-frame
context; nested-frame predicates are intentionally out of scope.

## Poll interval

Function mode accepts `pollIntervalMs`:

```json
{
  "tabId": "page-1",
  "type": "function",
  "value": "window.__ready === true",
  "timeout": 5000,
  "pollIntervalMs": 100
}
```

`pollIntervalMs` defaults to `200`, clamps to `50..5000`, and is passed to
Puppeteer as numeric `polling`.

## Fact-on-error response

Function mode returns structured facts instead of rejecting the whole MCP call
for predicate outcomes:

```json
{
  "action": "wait_for",
  "type": "function",
  "matched": false,
  "result": "predicate_error",
  "elapsedMs": 42,
  "pollIntervalMs": 200,
  "error": { "name": "Error", "message": "boom" }
}
```

`result` is one of:

- `matched`
- `timeout`
- `predicate_error`
- `navigation_lost`

Other `wait_for` modes keep their existing compatibility behavior.

## Redaction and telemetry

Predicate source can contain quoted cookies or tokens, so wait-for function
predicates are redacted before trace-like telemetry persistence. Metrics are
emitted as:

- `openchrome_wait_predicate_total{result=...}`
- `openchrome_wait_predicate_elapsed_ms{result=...}`
