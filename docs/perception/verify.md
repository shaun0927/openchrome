# Per-action verify signals

Issue [#827](https://github.com/shaun0927/openchrome/issues/827).

The `verify` field on the interaction tools (`interact`, `act`, `fill_form`)
upgrades the legacy `verify: boolean` capture-after-action helper to a
structured diff signal so that a caller can confirm an interaction had an
observable effect in **one tool call** instead of three.

## Mode matrix

| Mode           | What it returns                                                                                                                              | Cost                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `"none"`       | No `verify` field on the result. Byte-identical to develop.                                                                                  | 0                      |
| `"ax-diff"`    | `verify.ax_diff = { changed, summary, hash_before, hash_after }`. SHA-256 truncated to 16 hex chars over a stable AX-tree serialization.     | 2 × `Accessibility.getFullAXTree` |
| `"screenshot"` | `verify.screenshot = { phash_distance, before_thumb_png_b64, after_thumb_png_b64, skipped? }`. 64-bit DCT-pHash distance + 64×64 PNG thumbs. | 2 × `page.screenshot` + pHash |
| `"both"`       | Both `ax_diff` and `screenshot` reports.                                                                                                     | sum of the above       |

`runVerify` always emits `verify.total_bytes`. The full payload is **hard-capped
at 4 KB**: if the report would exceed the cap, thumbs are dropped first and
`screenshot.skipped` is set to `"capture_failed"`.

## Skip conditions

- `viewport_too_large` — viewport pixel count > 4,000,000 (e.g. a 4× DPR
  4K page). Captures are not even attempted.
- `capture_failed` — `page.screenshot()` threw, the PNG decoder rejected the
  buffer, **or** the assembled payload exceeded the 4 KB ceiling and the
  thumbs had to be dropped.
- `ax_unavailable` — the AX tree CDP call failed (e.g. a worker target).
  `ax_diff.note = "ax_unavailable"` and `changed` is `false`.

## Backwards-compat

| Input                         | Resolved mode |
| ----------------------------- | ------------- |
| `verify` absent / `undefined` | `"none"`      |
| `verify: false`               | `"none"`      |
| `verify: true`                | `"screenshot"` *(legacy `interact` behavior — also keeps the embedded WebP image)* |
| `verify: "none"`              | `"none"`      |
| `verify: "ax-diff"`           | `"ax-diff"`   |
| `verify: "screenshot"`        | `"screenshot"`|
| `verify: "both"`              | `"both"`      |

The JSON Schema uses `oneOf: [{type:'boolean'}, {type:'string', enum:[...]}]`
so existing clients that pass a boolean continue to validate.

## Examples

```jsonc
// Default — zero overhead, no verify field on the result.
{ "tool": "interact", "args": { "tabId": "...", "query": "Submit" } }

// AX-only — cheapest structured signal.
{ "tool": "interact", "args": { "tabId": "...", "query": "Submit", "verify": "ax-diff" } }
// → result.verify.ax_diff.changed === true, hash_before !== hash_after

// Legacy boolean — preserved.
{ "tool": "interact", "args": { "tabId": "...", "query": "Submit", "verify": true } }
// → result.verify.mode === "screenshot" PLUS the legacy embedded WebP image.

// Full diff signal.
{ "tool": "interact", "args": { "tabId": "...", "query": "Submit", "verify": "both" } }
// → result.verify.ax_diff + result.verify.screenshot, total_bytes ≤ 4096.
```

## Portability-harness alignment

- **P1/P2** — opt-in. `verify: "none"` is the default; the result shape is
  byte-identical to pre-#827 develop.
- **P3** — no LLM calls.
- **P4** — image work reuses the pure-JS pipeline (`src/contracts/png-decode.ts`,
  `src/contracts/phash.ts`); no `sharp`, no native deps.
- **P5** — nothing is persisted; the verify block lives only inside the
  immediate tool result.
