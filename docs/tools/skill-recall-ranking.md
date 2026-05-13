# Ranked skill recall

`oc_skill_recall` remains backward-compatible by default: without `task` or `ranked: true`, it returns the existing replay-aware deterministic order.

For task-aware recall, pass `task` (or `ranked: true`) with `domain` and optional `contract_id`. Ranked results include:

- `score`: deterministic lexical score with success/replay/contract boosts.
- `reason`: human-readable scoring explanation.
- `stepsPreview`: bounded first-step preview with secret-like keys and values redacted.
- `replaySignal`: `1`, `0`, or `-1` based on replay history.

No recalled skill is auto-executed. Hosts must inspect the result, validate any contract, and explicitly call replay/action tools.
