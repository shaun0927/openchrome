# Ranked skill recall

`oc_skill_recall` remains backward-compatible by default: without `task` or `ranked: true`, it returns the existing replay-aware deterministic order.

For task-aware recall, pass `task` (or `ranked: true`) with `domain` and optional `contract_id`. Ranked results include:

- `score`: deterministic lexical score with success/replay/contract boosts.
- `reason`: human-readable scoring explanation.
- `stepsPreview`: bounded first-step preview with secret-like keys and values redacted.
- `replaySignal`: `1`, `0`, or `-1` based on replay history.

No recalled skill is auto-executed. Hosts must inspect the result, validate any contract, and explicitly call replay/action tools.

## LLM-free reuse fast path (#1430)

Every recalled skill carries a `codegenReplay` pointer:

```jsonc
"codegenReplay": {
  "available": true,
  "artifacts": [{ "kind": "playwright", "path": "skills/<domain>/<id>.codegen.spec.ts" }]
}
```

`available` is `true` when the skill was recorded with the opt-in codegen pipeline
(`--codegen` / `OPENCHROME_CODEGEN`). This lets a host close the loop **without an
LLM round-trip**:

1. `oc_skill_recall` for the domain (optionally `task`-ranked).
2. Pick the top result whose `codegenReplay.available` is `true`.
3. Re-verify its `contract_id` and replay the artifact deterministically.

The pointer is surfaced as a fact only — recall still never auto-executes. When
codegen was disabled at record time, `available` is `false` and `artifacts` is
empty, so the host falls back to the normal steps-driven path.

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
