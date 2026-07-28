# Provider-neutral perception snapshots

`vision_find` keeps its legacy annotated screenshot output by default, but it also builds a provider-neutral `PerceptionSnapshot` internally. Callers can request that contract with `format: "snapshot"` or `format: "both"`.

The snapshot contract is exported from `src/vision/perception-types.ts` and is intentionally provider-neutral: DOM annotation, future OmniParser-compatible HTTP providers, and tests can all describe visible elements with stable snapshot-local IDs, labels, viewport-relative CSS pixel boxes, normalized ratios, provenance, and bounded warnings.

OpenChrome-emitted snapshots include `captureMode`. `viewport` uses live viewport coordinates and may be executed after the checks below. `tiled` aggregates document-space coordinates and is rejected by `interact mode="perception"`; recapture the target viewport first. Older provider snapshots may omit this additive field and retain viewport semantics.

## Execute a caller-selected target

The MCP host can select one exact snapshot-local element ID and pass the original viewport snapshot to `interact`:

```json
{
  "tabId": "target-123",
  "mode": "perception",
  "action": "click",
  "perception": {
    "snapshot": { "version": 1, "provider": "dom-annotator", "...": "PerceptionSnapshot" },
    "elementId": "v7"
  }
}
```

OpenChrome does not rank the snapshot or choose the element. It validates the caller's selection, binds it to the live tab and exact URL, and allows only `click`, `double_click`, or `hover`.

Use `vision_find` with its default `mode: "viewport"` for this flow. Tiled snapshots use document-space aggregation and are intentionally not executable through perception mode; capture the target viewport again before interacting.

- DOM-backed elements may be up to 60 seconds old. Their `backendDOMNodeId` is scrolled into view, checked for clickability, and resolved to a fresh CDP box before input.
- Visual-only elements may be up to 15 seconds old and require an unchanged viewport. Unsafe labels involving deletion, payment, transfer, credentials, MFA, OTP, or secrets fail closed.
- The response contains only bounded provenance: provider, element ID, source, resolution path, snapshot age, and final coordinates. It does not echo the snapshot or screenshot bytes.
- Existing `verify`, DOM-delta, stealth movement, `returnAfterState`, and DOM-backed replay capture remain available.

## Validation expectations

Provider output should pass `validatePerceptionSnapshot` before it is trusted by downstream grounding code. Validation diagnostics are bounded with `maxErrors` so malformed or hostile providers cannot flood MCP responses or model context. A failed validation should be surfaced as an actionable warning or an `isError` tool response instead of an uncaught MCP-server exception.

## Bounds and privacy

- `buildPerceptionSnapshotFromAnnotatedResult` caps element count with `maxElements`.
- `sanitizePerceptionLabel` truncates labels with `maxLabelLength`.
- Secret-like labels, including password fixture values, are redacted before entering the snapshot.
- Coordinates are clamped to the live viewport and emitted as both CSS pixels and `0..1` ratios.

## Non-goals

This layer does not add OmniParser, Python, Torch, model weights, persistent screenshot storage, server-side candidate selection, or an autonomous visual planning loop. External perception providers remain optional and adapt to this contract.
