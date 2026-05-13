# Privacy-safe failure episode memory

OpenChrome's hint learner records a bounded, privacy-safe failure episode when a
failed tool call is followed by a different successful tool call inside the
existing `PatternLearner` watch window. The episode is evidence-backed by that
successful follow-up; it is not created from speculative hints alone.

Persisted data lives next to `learned-patterns.json` as
`failure-episodes.json` when `PatternLearner.enablePersistence()` is enabled.
Each record stores only compact summaries:

- domain, task intent, and coarse state fingerprint
- failed tool and redacted failed action summary
- normalized error fingerprint
- recovery summary, recovery tool list, success evidence summary
- confidence, attempts, success count, and timestamps

The store redacts emails, bearer tokens, password/token/secret/API-key style
text, and long opaque tokens before writing. It never stores raw DOM dumps,
cookies, screenshots, credentials, form values, or network payloads.

Future matching requires the same failed tool, a compatible error fingerprint,
and compatible domain/task/state context when available. Matching produces an
advisory `learned-pattern` hint such as a suggested recovery tool and summary;
OpenChrome does not auto-execute the recovery.

Confidence starts at `0.60`, increases on repeated verified recovery, decreases
when callers report failed reuse through the store API, and is pruned below
`0.30`. The default cap is 100 recent/high-confidence episodes, with stale
entries pruned after 90 days.
