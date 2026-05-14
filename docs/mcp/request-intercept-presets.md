# `request_intercept` bandwidth presets

`request_intercept` owns OpenChrome's CDP `Fetch` request-blocking path. Issue
#861 adds two preset values so crawl and extraction workloads can reduce static
asset transfer without hand-writing resource-type rules.

## Presets

| Preset | Blocked CDP resource types | Use when |
| --- | --- | --- |
| `optimize-bandwidth` | `Image`, `Media`, `Font`, `Stylesheet` | You only need DOM/AX/text extraction and want the largest bandwidth reduction. |
| `optimize-bandwidth-light` | `Image`, `Media`, `Font` | You still need CSS layout fidelity for screenshots or layout-sensitive selectors. |

The preset table is the implementation source of truth in
`src/tools/request-intercept.ts` (`PRESET_RESOURCE_TYPES`) and is covered by
`tests/tools/request-intercept-preset.test.ts`.

## Basic usage

Enable the heavy preset on a tab:

```json
{
  "tabId": "<tab-id>",
  "action": "enable",
  "preset": "optimize-bandwidth"
}
```

Enable the light preset:

```json
{
  "tabId": "<tab-id>",
  "action": "enable",
  "preset": "optimize-bandwidth-light"
}
```

Unknown preset values return a structured error instead of throwing:

```json
{
  "error": "unknown_preset",
  "supported": ["optimize-bandwidth", "optimize-bandwidth-light"]
}
```

## Precedence and overrides

Preset rules are expanded first, then user-supplied rules are appended. Matching
uses the existing `request_intercept` precedence rules:

1. `allow` wins over a preset `block`.
2. User `modify` rules can override a preset block for the same request.
3. User `block` rules continue to work as before.

Example: block static assets except SVGs.

```json
{
  "tabId": "<tab-id>",
  "action": "enable",
  "preset": "optimize-bandwidth",
  "allow": ["*.svg"]
}
```

Disabling interception removes preset rules. Re-enabling without `preset` does
not keep stale preset rules.

## Environment auto-apply

Set `OPENCHROME_OPTIMIZE_BANDWIDTH` to apply a preset whenever
`request_intercept` is enabled without an explicit per-call preset:

```bash
OPENCHROME_OPTIMIZE_BANDWIDTH=optimize-bandwidth openchrome serve --auto-launch
```

A per-call `preset` overrides the environment value. Invalid or empty environment
values are ignored and behave like no preset.

## Metrics

Preset-blocked static assets increment deterministic estimate counters inside the
existing request interception path:

- `openchrome_intercept_estimated_response_bytes_total{resource_type,estimate_source}`
- `openchrome_intercept_estimated_blocked_response_bytes_total{resource_type,estimate_source}`

The estimates are intentionally deterministic by resource type because CDP does
not expose final response bytes for requests that are aborted before transfer.
The legacy observed/blocked byte counters remain unchanged for paths that have
real byte counts.

## Verification anchors

- Unit coverage: `tests/tools/request-intercept-preset.test.ts`
- Tool-list allow-list: `scripts/verify/A5-tools-parity.mjs`
- Deterministic fixture for live/manual verification:
  `tests/fixtures/pages/bandwidth-heavy.html`
