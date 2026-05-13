# Reflection strategy controls

`execute_plan` accepts an optional `reflectionStrategy` field:

- `none` — no reflection ids and no last-attempt summary.
- `last_attempt` — response metadata includes a bounded, redacted last-attempt summary when supplied in `params.lastAttemptSummary` / `params.lastAttempt`.
- `reflection` — response metadata lists at most three matching passive reflection ids from `ReflectionStore`.
- `last_attempt_and_reflection` — combines both bounded surfaces.

When omitted, `execute_plan` keeps the legacy response shape and does not add reflection metadata. Invalid values return `INVALID_REFLECTION_STRATEGY` rather than throwing. Reflections remain passive metadata; OpenChrome does not execute stored `nextPlan` entries.
