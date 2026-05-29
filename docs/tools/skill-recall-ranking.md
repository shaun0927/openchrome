# Ranked skill recall

`oc_skill_recall` remains backward-compatible by default: without `task` or `ranked: true`, it returns the existing replay-aware deterministic order.

For task-aware recall, pass `task` (or `ranked: true`) with `domain` and optional `contract_id`. Ranked results include:

- `score`: deterministic lexical score with success/replay/contract boosts.
- `reason`: human-readable scoring explanation.
- `stepsPreview`: bounded first-step preview with secret-like keys and values redacted.
- `replaySignal`: `1`, `0`, or `-1` based on replay history.

No recalled skill is auto-executed. Hosts must inspect the result, validate any contract, and explicitly call replay/action tools.

## Optional audit-log run statistics (`use_run_stats`, #1457)

Pass `use_run_stats: true` (which also enables ranked recall) to factor each
skill's recent-window **failure rate**, derived from the audit log, into the
score. A skill that fails often is demoted proportionally, and its `reason`
gains a `run_fail_rate=<rate> (<failures>/<runs> in window)` note.

This is **opt-in**: when the flag is unset, recall performs **no audit-log I/O**
and behaves exactly as before — the default path stays fast and deterministic.

## On "selector confidence"

OpenChrome does not store a separate per-selector confidence model. The
deterministic **skill confidence** signal *is* the recall ranking itself:
`replaySignal` (passed/failed replay history), `successCount`, the optional
`contract_id` boost, and the opt-in `use_run_stats` failure-rate penalty above.
These are computed facts surfaced for the host to weigh — there is no hidden
learned score.
