# Outcome Contracts — DSL Reference

> Status: Implemented in `src/contracts/` as part of issue [#705].
> The runtime that evaluates contracts against a live Chromium page lives in
> [#706] (Contract runtime). This document covers the **DSL only** — the
> declarative shape and per-assertion semantics. Until #706 lands you can
> exercise every assertion against a mock `EvalContext` (see
> `tests/contracts/evaluators.test.ts`).

[#705]: https://github.com/shaun0927/openchrome/issues/705
[#706]: https://github.com/shaun0927/openchrome/issues/706

## Why a DSL?

A skill that ends with `click("Place order")` has no way to prove it
succeeded. Outcome Contracts make success **machine-checkable**:

```jsonc
// "the order was placed" expressed as a contract postcondition
{
  "kind": "and",
  "children": [
    { "kind": "url", "pattern": "/orders/[A-Z0-9]{8}/confirmation" },
    { "kind": "dom_text", "selector": "h1", "contains": "Thank you" },
    { "kind": "no_dialog" }
  ]
}
```

If any child fails, the runtime (#706) escalates per the contract's
`on_fail` policy and emits an evidence bundle (#707).

## Authoring an assertion

Every leaf assertion has the same outer shape:

```ts
type Assertion =
  | { kind: "url",         pattern: string }
  | { kind: "dom_text",    selector?: string, contains: string }
  | { kind: "dom_count",   selector: string, op: "eq" | "gte" | "lte", value: number }
  | { kind: "network",
      url_pattern: string,
      status_in: number[],
      since: "contract_enter" | "last_tool_call" }
  | { kind: "screenshot_class",
      class_id: string,
      distance_max: number /* Hamming distance over 64-bit pHash */ }
  | { kind: "no_dialog" }
  | { kind: "and", children: Assertion[] }
  | { kind: "or",  children: Assertion[] }
  | { kind: "not", child:    Assertion   }
```

`and` and `or` short-circuit; children are evaluated in declaration order.
`not` takes a single `child` (not `children`) — express "neither A nor B"
as `and([not(A), not(B)])`.

## Validation

Run author-time validation before persisting a contract:

```ts
import { validateAssertion } from "openchrome-mcp/dist/contracts";

const result = validateAssertion(rawJson);
if (!result.ok) {
  for (const err of result.errors) console.error(err.path, err.message);
  process.exit(1);
}
```

Validator output is **batched**: every issue is reported in a single pass
so an LLM can correct multiple mistakes at once. Malformed input is never
silently accepted; the runtime refuses to evaluate an unvalidated DSL
fragment.

## Per-assertion reference

### `url`

```jsonc
{ "kind": "url", "pattern": "^https://amazon\\.com/orders/[A-Z0-9]+/confirmation/?$" }
```

- `pattern`: JS RegExp source. Anchor with `^` / `$` if you want strict
  matches — the DSL never anchors automatically.
- Evidence: `{ url, pattern }`.

### `dom_text`

```jsonc
{ "kind": "dom_text", "selector": "h1", "contains": "Thank you" }
{ "kind": "dom_text", "contains": "Order placed" }   // selector defaults to body
```

- `contains` is substring match against the selector's `innerText`. Use
  `and([dom_text(...), dom_text(...)])` for AND-of-substrings.
- Evidence: `{ selector, contains, text_preview, text_length }`. Preview is
  truncated; long pages won't blow up evidence bundles.

### `dom_count`

```jsonc
{ "kind": "dom_count", "selector": ".cart-line", "op": "eq",  "value": 0 }
{ "kind": "dom_count", "selector": ".cart-line", "op": "gte", "value": 1 }
```

- `op` is one of `eq`, `gte`, `lte`. JS comparison tokens (`==`, `>=`)
  are NOT accepted in the JSON form.
- Evidence: `{ selector, op, target, observed }`.

### `network`

```jsonc
{
  "kind": "network",
  "url_pattern": "^https://api\\.example\\.com/orders$",
  "status_in": [200, 201],
  "since": "contract_enter"
}
```

- `url_pattern` is parsed as a JS RegExp first; if it fails to parse, it
  falls back to plain substring containment.
- `since` markers:
  - `contract_enter` — entries since `runWithContract` began the pre-check.
  - `last_tool_call` — entries since the most recent MCP tool invocation.
- Evidence: `{ url_pattern, status_in, since, matched_count, scanned_count, last_match }`.

### `screenshot_class`

```jsonc
{ "kind": "screenshot_class", "class_id": "checkout.success", "distance_max": 12 }
```

- `class_id` may contain alphanumerics, `.`, `_`, `-` only — path
  separators are rejected so the class can be safely used as a directory
  component.
- `distance_max` is the Hamming distance allowed against the 64-bit pHash
  of the most recent screenshot (range 0..64).
- Evidence: `{ class_id, distance, distance_max, threshold_recommended, nearest_exemplar }`.

Add or update a class via the CLI:

```bash
oc contract teach checkout.success ./screenshots/order-1.png
oc contract teach checkout.success ./screenshots/order-2.png
oc contract show  checkout.success
```

`teach` recomputes `threshold.json` (mean pairwise Hamming + 2σ, floored
at 4 and capped at 16) on every call. The original PNG is preserved
under `~/.openchrome/screenshot-classes/<class_id>/exemplars/<n>.png` so
you can re-derive the threshold later.

### `no_dialog`

```jsonc
{ "kind": "no_dialog" }
```

- Passes iff no JS dialog (alert / confirm / prompt / beforeunload) is
  open. Useful as a postcondition guard against phishing-style overlays
  that block subsequent actions.
- Evidence: `{ dialog_open }`.

### `and` / `or` / `not`

```jsonc
{
  "kind": "and",
  "children": [
    { "kind": "url", "pattern": "/orders/[A-Z0-9]+/confirmation" },
    { "kind": "or", "children": [
      { "kind": "dom_text", "selector": "h1", "contains": "Thank you" },
      { "kind": "dom_text", "selector": "h1", "contains": "Order placed" }
    ]},
    { "kind": "not", "child": { "kind": "no_dialog" } }
  ]
}
```

- `and`/`or` require non-empty `children`.
- `not` takes a single `child`.
- Logical-node evidence carries the per-child evidence chain so you can
  see which branch failed without re-running the contract.

## Evidence shape

Every evaluator emits the same structure:

```ts
interface Evidence {
  passed: boolean;
  assertion_kind: Assertion["kind"];
  details: Record<string, unknown>;
  trace_ref?: { trace_id: string; from_ts: number; to_ts: number };
  screenshot_path?: string;
}
```

`assertion_kind` is renamed from `kind` to avoid shadowing the assertion's
own `kind` field when the runtime merges both into a single record.

`Evidence` is JSON-serialisable in the strict sense: `JSON.stringify`
followed by `JSON.parse` is lossless for every assertion kind in this
document. If you need to wire trace events to a replay UI, attach
`trace_ref` from the runtime — the DSL itself never invents trace IDs.

## Worked example — `amazon.checkout`

```jsonc
{
  "id": "amazon.checkout.v1",
  "pre": {
    "kind": "and",
    "children": [
      { "kind": "url", "pattern": "^https://www\\.amazon\\.com/.+" },
      { "kind": "dom_count", "selector": ".cart-line", "op": "gte", "value": 1 }
    ]
  },
  "post": {
    "kind": "and",
    "children": [
      { "kind": "url", "pattern": "/gp/buy/thankyou/handlers/display.html" },
      { "kind": "dom_text", "selector": "h1", "contains": "Thank you" },
      {
        "kind": "network",
        "url_pattern": "^https://www\\.amazon\\.com/orders/.*$",
        "status_in": [200],
        "since": "contract_enter"
      },
      { "kind": "screenshot_class", "class_id": "amazon.checkout.success", "distance_max": 14 },
      { "kind": "no_dialog" }
    ]
  }
}
```

The exemplar set for `amazon.checkout.success` is taught via:

```bash
oc contract teach amazon.checkout.success ./fixtures/amazon-success-1.png
oc contract teach amazon.checkout.success ./fixtures/amazon-success-2.png
oc contract teach amazon.checkout.success ./fixtures/amazon-success-3.png
oc contract show  amazon.checkout.success
```

## Out of scope for this issue

- LLM-driven dynamic assertion authoring (operator-authored only for v1).
- Negative-presence assertions over network bodies — only headers/status
  in v1; body assertions land with #706's request interception work.
- Cross-frame `dom_text` / `dom_count` resolution — handled by #706's
  frame-tree walker; the DSL stays agnostic.
