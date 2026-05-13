# Provider-neutral perception snapshots

`vision_find` keeps its legacy annotated screenshot output by default, but it also builds a provider-neutral `PerceptionSnapshot` internally. Callers can request that contract with `format: "snapshot"` or `format: "both"`.

The snapshot contract is exported from `src/vision/perception-types.ts` and is intentionally provider-neutral: DOM annotation, future OmniParser-compatible HTTP providers, and tests can all describe visible elements with stable snapshot-local IDs, labels, viewport-relative CSS pixel boxes, normalized ratios, provenance, and bounded warnings.

## Validation expectations

Provider output should pass `validatePerceptionSnapshot` before it is trusted by downstream grounding code. Validation diagnostics are bounded with `maxErrors` so malformed or hostile providers cannot flood MCP responses or model context. A failed validation should be surfaced as an actionable warning or an `isError` tool response instead of an uncaught MCP-server exception.

## Bounds and privacy

- `buildPerceptionSnapshotFromAnnotatedResult` caps element count with `maxElements`.
- `sanitizePerceptionLabel` truncates labels with `maxLabelLength`.
- Secret-like labels, including password fixture values, are redacted before entering the snapshot.
- Coordinates are clamped to the live viewport and emitted as both CSS pixels and `0..1` ratios.

## Non-goals

This layer does not add OmniParser, Python, Torch, model weights, persistent screenshot storage, or automatic clicking from visual elements. External perception providers should remain optional and adapt to this contract.
