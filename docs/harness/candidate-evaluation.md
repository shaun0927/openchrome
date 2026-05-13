# Harness candidate evaluation

`npm run harness:evaluate-candidates -- --ci` evaluates checked-in recovery and hint candidates against deterministic local scenarios. It is an offline harness gate: OpenChrome does not generate candidates with an LLM, does not mutate production hint rules, and does not import results automatically.

Outputs:

- `artifacts/harness-candidates/latest.json` — versioned machine-readable report.
- `artifacts/harness-candidates/latest.md` — reviewer summary.

The report includes candidates, scenarios, per-candidate/per-scenario scores, tool traces, safety violations, rejected candidates, recommended candidates, best overall, and best per failure family. A candidate is recommended only when it is best for at least one failure family and passes safety gates. Unsafe/destructive candidates remain in fixtures to prove rejection behavior.
