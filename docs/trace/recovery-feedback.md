# Recovery feedback bundles

OpenChrome writes best-effort `RecoveryFeedbackBundle` JSONL records for high-signal failed browser episodes such as progress-tracker stalls and blocked-page hints. The artifact is facts-only: it records what failed, deterministic hints that fired, attempted recovery metadata when available, and correlation timestamps/trace references. It never calls an LLM or changes tool behavior.

Default path in the MCP server is `.openchrome/recovery-feedback/YYYY-MM-DD.jsonl` under the current working directory. `RecoveryFeedbackWriter` also supports `OPENCHROME_RECOVERY_FEEDBACK_DIR` for standalone/offline use.

Each record is capped to 32 KiB. Result excerpts and hints are truncated, and known secret-like strings (password/MFA/token/secret fixtures plus configured OpenChrome secrets) are redacted before persistence.

Maintainers can attach sanitized records to regression PRs to answer:

1. which tool and failure category triggered the episode;
2. which hints or recovery advice fired;
3. whether recovery was attempted or escalated;
4. which session/timestamps can be correlated with timeline or trace logs.
