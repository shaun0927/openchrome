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
  | { kind: "image_qa",   question: string, expected_pattern: string }
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

## Registered contract IDs

`oc_assert` accepts either an inline assertion under `contract` or a registered
template ID under `contract_id`. These fields are mutually exclusive. Passing
both returns `verdict: "inconclusive"` with
`error_code: "CONTRACT_ID_CONFLICT"` so hosts never have to infer precedence.

Registered IDs resolve through the canonical default template registry exported
from `src/contracts/templates`. That registry is the single source of truth for
built-in outcome-contract templates and is populated from the built-in template
catalog, currently `public-web.page-meta@1`.

Lookup is closed-world:

- malformed IDs return `error_code: "CONTRACT_ID_MALFORMED"`;
- unknown IDs return `error_code: "CONTRACT_ID_UNKNOWN"`;
- registered templates without an `assertions` tree return
  `error_code: "CONTRACT_TEMPLATE_NO_ASSERTIONS"`.

The existing inline assertion path is unchanged and remains the portable way to
evaluate ad hoc assertions. Schema-only templates, such as
`public-web.page-meta`, can be listed and used by schema-diff consumers, but
they are not executable by `oc_assert` until they carry assertions.

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

### `image_qa`

```jsonc
{ "kind": "image_qa", "question": "is the page in dark mode?", "expected_pattern": "^yes" }
```

- Asks the **host LLM** a free-form `question` about the most recent
  screenshot and matches the answer against `expected_pattern` (JS
  RegExp source, vetted by the same safe-regex guard as `url` /
  `network`).
- The answer is produced host-side via MCP `sampling/createMessage`
  (the runtime's optional `imageQaSample` hook). OpenChrome never calls
  a model itself (SSOT [#1359]) — when the host does not wire the hook,
  or replies `unsupported_by_host`, the assertion is **inconclusive**
  (`passed: false`) rather than failing hard. The single-call
  `oc_assert` surface does not wire the hook, so `image_qa` is only
  decidable inside a sampling-capable host runtime.
- Evidence: `{ question, answer, expected_pattern }` on a decided
  result, or `{ reason, question }` when inconclusive.

[#1359]: https://github.com/shaun0927/openchrome/issues/1359

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

## Durable `oc_assert` evidence

After `oc_assert` evaluates a supplied snapshot, it persists a redacted
artifact and returns additive lifecycle metadata:

```jsonc
{
  "verdict": "pass",
  "evidence_handle": "ev_<uuid>",
  "evidence_status": "persisted",
  "evidence_expires_at": "2026-07-28T12:30:00.000Z",
  "evidence_get": {
    "tool": "oc_evidence_get",
    "arguments": { "evidence_handle": "ev_<uuid>" }
  },
  "trace_status": "unavailable",
  "trace_unavailable_reason": "..."
}
```

The retention contract is:

- artifacts remain retrievable for 30 minutes;
- persistence rejects artifacts larger than 1 MiB, retains at most 16 MiB or
  256 artifacts per session/tenant owner, and caps one OpenChrome process at
  64 MiB or 1,024 artifacts; the assertion verdict still returns with
  `evidence_status: "unavailable"` when a retention quota is reached;
- expired handles fail immediately by timestamp, while an unref periodic sweep
  removes expired files and crash-left temporary writes from disk; persistence
  maintains a bounded in-memory index and does not synchronously rescan every
  artifact on each `oc_assert` call;
- `oc_evidence_get` authorizes the owning OpenChrome process instance, MCP
  session, and tenant before returning artifact contents; a handle disclosed to
  an independent stdio/daemon process is rejected even when both processes use
  the default logical session and tenant IDs;
- API-key/JWT requests derive evidence ownership from the authenticated tenant;
  disabled/legacy HTTP requests use the effective `X-Tenant-Id` request tenant
  instead of the synthetic `anonymous`/`legacy` principal;
- HTTP `DELETE /mcp`, `sessions/delete`, and SessionManager deletion events
  delete artifacts only for the ended session/tenant owner; real browser
  sessions emit the same tenant-scoped deletion event during TTL cleanup and
  shutdown, and HTTP DELETE rejects a request whose authenticated/header tenant
  does not match the tenant bound to the MCP session; MCP `sessions/delete`
  applies the same effective request-tenant check before deleting a managed
  browser session or evidence;
- expired, deleted, malformed, corrupt, and unauthorized handles return stable
  error codes rather than filesystem paths or partial contents;
- credential-pattern and configured-secret redaction runs before the artifact
  is written and again before it is returned.

The artifact records the verification verdict, assertion, evaluator evidence,
session, tenant, contract source/ID, timestamp, and optional caller-supplied
capture provenance:

```jsonc
{
  "contract": { "kind": "url", "pattern": "example\\.com" },
  "evidence": {
    "provenance": {
      "target_id": "<tab-id>",
      "worker_id": "<worker-id>",
      "captured_at": "2026-07-28T12:00:00.000Z"
    },
    "snapshot": { "url": "https://example.com" }
  }
}
```

`oc_assert` is snapshot-driven and does not start a runtime trace. It therefore
omits `trace_ref` and reports `trace_status: "unavailable"`; a future live
runtime may attach a real trace reference only after the referenced artifact
exists. Schema/contract errors that occur before evaluation, including a
missing snapshot, do not return an `evidence_handle`.

### `failure_category` on a `fail` verdict

When `oc_assert` returns `verdict: "fail"`, the output also carries a
machine-stable `failure_category` (one of the shared `FAILURE_CATEGORIES`,
e.g. `POSTCONDITION_FAILED`, `ELEMENT_NOT_FOUND`, `NAVIGATION_TIMEOUT`) plus a
short `failure_reason`. A clean expected/actual mismatch is
`POSTCONDITION_FAILED`; if an evaluator surfaced an error string (e.g. a
detached node), that error is classified instead. This lets a host agent branch
recovery (retry vs re-auth vs solve-captcha) on a stable code rather than
re-parsing raw diffs. Classification is purely deterministic — OpenChrome never
calls a model to decide it.

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
