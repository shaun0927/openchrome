# `oc_progress_status`

`oc_progress_status` reports read-only anti-wandering diagnostics for a session. It summarizes recent completed tool calls as `progressing`, `stalling`, or `stuck`, and returns bounded advisory next-call suggestions.

The tool never stops an episode, retries a failed action, restores a checkpoint, clicks, types, navigates, or calls an LLM. Host agents and benchmark harnesses decide whether to follow the advisory policy.

## Thresholds

- `stuck`: `consecutiveErrors >= 3` or `consecutiveNonProgress >= 5`.
- `stalling`: `consecutiveNonProgress >= 3`.
- `stop_episode` advisory: `consecutiveNonProgress >= 8` or `consecutiveErrors >= 5`.
- `switch_strategy` advisory: coordinate-click streak, tool oscillation, or repeated same-tool streak.

Observation-only calls such as `read_page`, `tabs_context`, and `computer` screenshots count as non-progress for streak purposes.

## Privacy and bounds

- `window` defaults to 10 and is clamped to 3–50.
- `suggestedNextCalls` is capped at 3 entries.
- `includeRecentCalls:true` returns compact redacted call summaries only; no raw page text or screenshots are included.
- Arguments with keys matching password/token/secret/credential/api-key are redacted.
