# `vision_find` annotation options

`vision_find` captures an annotated screenshot plus an element map for
vision-assisted agents. Issue #853 adds three opt-in accuracy/coverage options
while preserving the default viewport-only behavior for existing callers.

## Options

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `occlusionFilter` | `boolean` | `false` | When `true`, drops elements whose center point is covered by another DOM element via `elementFromPoint`. |
| `iframes` | `"none" \| "same-origin" \| "all"` | `"none"` | Traverses accessible frames and translates element coordinates into top-frame space. Cross-origin frames are never evaluated into; `"all"` reports them in `iframes.skipped`. |
| `mode` | `"viewport" \| "tiled"` | `"viewport"` | `viewport` captures the current viewport. `tiled` scrolls the document in viewport-tall steps and returns per-tile screenshots plus a unified document-space element map. |

Recommended high-accuracy call:

```json
{
  "tabId": "<tab-id>",
  "occlusionFilter": true,
  "iframes": "same-origin",
  "mode": "viewport"
}
```

Full-document call:

```json
{
  "tabId": "<tab-id>",
  "occlusionFilter": true,
  "iframes": "same-origin",
  "mode": "tiled"
}
```

## Occlusion filtering

With `occlusionFilter: true`, each candidate element is checked at its center
point. The element is kept only when the hit-test returns the element itself, a
descendant, or a containing element that represents the same interactive target.
This removes buttons hidden underneath fixed overlays, sticky headers, drawers,
and cookie banners.

When enabled, the result may include:

```json
{
  "occludedDropped": 3
}
```

When `occlusionFilter` is omitted or `false`, this field is absent and the legacy
filtering behavior is preserved.

## Iframe traversal

`iframes: "same-origin"` traverses same-origin frames, including `srcdoc` and
compatible `about:blank` frames. Coordinates are translated into top-frame
coordinates so callers can use the returned `centerX`/`centerY` directly.

`iframes: "all"` still respects browser same-origin policy. Cross-origin frames
are skipped and reported instead of throwing.

Result extension:

```json
{
  "iframes": {
    "traversed": [
      { "frameId": "<frame-id>", "origin": "https://example.test", "elementCount": 2 }
    ],
    "skipped": [
      { "origin": "https://example.com", "reason": "cross-origin" }
    ]
  }
}
```

Caps:

- Maximum iframe depth: `4`
- Maximum iframe count per page: `20`
- Skip reasons: `cross-origin`, `depth-cap`, `count-cap`

## Tiled mode

`mode: "tiled"` scrolls from the top of the document in viewport-height steps,
captures each tile, and merges visible elements into one document-space map. The
original scroll position is restored in a `finally` path.

Result extension:

```json
{
  "tiling": {
    "tileCount": 3,
    "tileHeight": 900,
    "tiles": [
      { "tileTop": 0, "imageBase64": "...", "mimeType": "image/png" }
    ],
    "truncated": false
  }
}
```

For compatibility, the top-level `screenshot` and `mimeType` fields still contain
the first tile when tiled mode is used.

Caps:

- Maximum tiles: `20`
- Maximum returned elements: `1500`
- Maximum annotated pixels: `16 MP`
- Truncation reasons: `tile-cap`, `element-cap`, `mp-cap`

## Verification anchors

- Occlusion: `tests/vision/screenshot-analyzer.occlusion.test.ts`
- Iframes: `tests/vision/screenshot-analyzer.iframes.test.ts`
- Tiling: `tests/vision/screenshot-analyzer.tiling.test.ts`
- Tool wrapper/default compatibility: `tests/vision/vision-find.test.ts`
