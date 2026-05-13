# Visual trajectory evidence bundles

Visual trajectory capture is disabled by default. Enable it only for debugging,
benchmarking, or PR verification where visual/perception artifacts are needed.

## Enablement

- Per call: pass `recordTrajectory: true` to `vision_find`.
- Environment: set `OPENCHROME_VISUAL_TRAJECTORY=1`.
- Artifact root: set `OPENCHROME_VISUAL_TRAJECTORY_DIR=/path/to/artifacts`.

When no root is configured, artifacts are written under:

```text
~/.openchrome/trajectories/visual/
```

## Artifact shape

Each enabled `vision_find` call creates a trace directory containing:

- `events.jsonl` — one JSON event with perception/action/outcome metadata.
- `annotated.png` — annotated screenshot artifact, referenced by path.

The JSON event records:

- `sessionId`, `tabId`, `url`, `toolName`, and timestamp.
- optional visual query/action target.
- provider, element count, latency, and warnings.
- screenshot file path, not inline image data.
- redaction metadata: `{ "inlineImages": false, "secretsRedacted": true }`.

## Privacy and safety model

- No visual artifacts are written unless explicitly enabled.
- Images are stored as files and referenced by path; they are not inlined in
  JSONL events.
- The event schema is metadata-first so maintainers can share sanitized event
  rows without attaching screenshots.
- Capture failure is best effort and never fails the underlying `vision_find`
  call.

## Verification

Run `vision_find` once with `recordTrajectory: true`, then inspect:

```bash
find "$OPENCHROME_VISUAL_TRAJECTORY_DIR" -maxdepth 2 -type f
jq . "$OPENCHROME_VISUAL_TRAJECTORY_DIR"/visual-*/events.jsonl
```

Run the same call without `recordTrajectory` or
`OPENCHROME_VISUAL_TRAJECTORY=1`; the directory should remain empty.
