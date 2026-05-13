# Checkpoint timeline

`oc_checkpoint` keeps its original `save`, `load`, and `delete` behavior, and now also writes a bounded append-only timeline under the checkpoint directory.

## Actions

- `save`: writes `current-checkpoint.json` and a timeline entry under `timeline/<checkpointId>.json`. The response includes `checkpointId` and, when available, `parentId`.
- `list`: returns recent checkpoints newest-first with labels, age, current URL, step counts, tab count, journal range, and retention limits. Empty directories return an empty list.
- `load`: without `checkpointId`, loads the latest/current checkpoint for backward compatibility. With `checkpointId`, loads that timeline entry.
- `delete`: without `checkpointId`, deletes the current checkpoint. With `checkpointId`, deletes that timeline entry and also clears current if it points at the same id.

## Bounds and recovery model

Timeline retention defaults to 10 entries and can be adjusted with `OPENCHROME_CHECKPOINT_TIMELINE_MAX` (1..100). Corrupt timeline entries are skipped with warnings in `list`; they do not crash the server.

The timeline is a read model for caller-controlled recovery. OpenChrome does not replay actions, roll back website side effects, or choose a new plan.
