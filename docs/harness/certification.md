# Harness certification suite

`npm run harness:certify -- --ci` writes a deterministic reliability certification report for local OpenChrome harness scenarios. The suite is intentionally harness-only: it does not add DSPy, Python, LLM calls, or production runtime behavior.

Artifacts:

- `artifacts/harness-certification/latest.json`
- `artifacts/harness-certification/latest.txt`

Required scenarios are `healthy-form`, `stale-ref-recovery`, `auth-redirect-detection`, `blocked-page-detection`, `slow-render-within-timeout`, and `large-dom-bounded-extract`. Each scenario reports success, tool count, non-progress calls, stuck events, recovery attempts, recovery success, duration, p95/p99 latency, hints, contract verdicts, failure reason, thresholds, and tool trace.

Thresholds live in `tests/harness/harness-certification.thresholds.json`:

- `globalTimeoutMs`, `scenarioTimeoutMs`: fail-fast timeout budgets.
- `maxNonProgressCalls`, `maxStuckEvents`: wandering guardrails.
- `maxP99ToolLatencyMs`: conservative latency regression guard.
- `maxToolCalls`: loop/bloat guard.

The current implementation uses deterministic local fixture traces so CI remains stable. The report still records the OpenChrome server command shape and tool traces required for PR review. A future live lane can switch `server.mode` from `deterministic-local-fixture` to `real-http-mcp` without changing the report schema.
