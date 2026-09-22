# Decision corpus schema (G0)

One JSON object per line (JSONL). Each line is one *case*: a decision input plus,
optionally, a human label. The corpus is used by `scripts/eval-decisions.ts` to
compare decision providers (`noop`, `regex`, `file`, `typesafe`).

The TypeScript source of truth is `tests/fixtures/decisions/schema.ts`
(`DecisionCase`, `validateCase`). This file is the human-readable copy.

## Top-level shape

```json
{"id":"...","kind":"element","lang":"en","pool":"trajectory","split":"A",
 "input":{...},"label":{"answer":"...","labeler":"...","notes":"..."},
 "truth_hint":{...},"meta":{...}}
```

| field        | type                                             | required | notes |
|--------------|--------------------------------------------------|----------|-------|
| `id`         | string, non-empty, unique in a file              | yes      | stable across re-extraction; `<pool>-<kind>-<hash>` by convention |
| `kind`       | `element` / `outcome` / `irreversible` / `gate`  | yes      | selects the `input` shape and the answer set |
| `lang`       | `ko` / `en`                                      | yes      | `ko` when any Hangul is present in the input text |
| `pool`       | `trajectory` / `fixture` / `public`              | yes      | where the input came from; drives the A/B split rule |
| `split`      | `A` / `B`                                        | no       | assigned by `scripts/decisions/split.ts`; `trajectory` is always `A` |
| `input`      | object (kind-specific, below)                    | yes      | |
| `label`      | `{answer, labeler, notes?}`                      | no       | human ground truth; absent in `*.unlabeled.jsonl` |
| `truth_hint` | object (free-form)                               | no       | machine-derived hint emitted by the trajectory/fixture harness; **never** used as ground truth by the evaluator |
| `meta`       | object (free-form)                               | no       | provenance (source node ids, derivation notes); ignored by the evaluator |

A case may carry both `label` and `truth_hint`. The evaluator only scores cases
that have a `label`; unlabeled cases are counted and skipped.

## Kind-specific `input` and `label.answer`

### `element`

```json
"input":{"query":"Sign in button",
         "view":{"targets":[{"ref":"ref_3","role":"button","name":"Sign in","value":"","state":""}],
                 "above":0,"below":12,
                 "history":[{"action":"click ref_1","result":"SILENT_CLICK"}]},
         "raw_snapshot_path":"artifacts/decision/G0/snapshots/abc.txt"}
```

- `query` (string): natural-language target description.
- `view.targets[]`: `ref` (string, unique in the view), `role`, `name` (strings), `value`, `state` (strings, may be empty).
- `view.above` / `view.below` (numbers): elements scrolled out of view above/below.
- `view.history[]`: prior `{action, result}` pairs (strings).
- `view.history[].resolution` (optional): `{resolver:"ax"|"css"|"none", ax_match_level?:1|2|3|4, css_score?:number}`. This is evidence for G3 threshold freeze, not a label.
- `raw_snapshot_path` (optional string).
- `label.answer`: one of the `ref`s in `view.targets`, or `"none"`.

### `outcome`

```json
"input":{"delta":"~ button \"Save\" aria-pressed=true","target_role":"button",
         "before_url":"https://a/x","after_url":"https://a/x"}
```

- `delta` (string, may be empty): DOM delta text as produced by `withDomDelta()`, or the closest recorded stand-in (see extraction notes).
- `target_role` (optional string), `before_url` / `after_url` (optional strings).
- `label.answer`: `SUCCESS` | `SILENT_CLICK` | `WRONG_ELEMENT` | `ELEMENT_NOT_FOUND` | `TIMEOUT` | `EXCEPTION`
  (`InteractionOutcome` in `src/recovery/ralph/outcome-classifier.ts`).

### `irreversible`

```json
"input":{"tool":"act","args":{"action":"click","query":"Place order"},
         "page_context":{"url":"https://shop/checkout","title":"Checkout"}}
```

- `tool` (string), `args` (object), `page_context` (object; `url`/`title` conventional, free-form).
- `label.answer`: `allow` | `preview_required` | `elicitation_required` | `checkpoint_required` | `blocked`
  (`PolicyDecision` in `src/security/tool-risk-policy.ts`).

### `gate`

```json
"input":{"title":"Just a moment...","text_excerpt":"Checking if the site connection is secure. cloudflare",
         "html_excerpt":"<div id=\"cf_chl_...\">"}
```

- `title`, `text_excerpt` (strings), `html_excerpt` (optional string).
- `label.answer`: `bot_check` | `login` | `paywall` | `two_factor` | `none`
  (cf. `src/gates/detect-other-gates.ts`; `login` covers the SSO redirect signal).

## Files

- `pool-trajectory.unlabeled.jsonl` — extracted by `scripts/decisions/extract-trajectory.ts` from
  `.openchrome/recovery/trajectory.jsonl` and `.openchrome/recovery-feedback/*.jsonl`. No labels.
- `split.json` — written by `scripts/decisions/split.ts`: `{seed, counts, sha256}` where `sha256[split]`
  is the SHA-256 of the sorted, newline-joined ids in that split.

## Split rule

`trajectory` pool cases are always split `A` (they are the in-distribution pool a heuristic was
tuned on). `fixture` and `public` pool cases are assigned `A`/`B` 50/50 by the parity of
`sha256(seed + ":" + id)`; the seed is a constant committed in `scripts/decisions/split.ts`.

## Broken-input modes (evaluator)

- `--broken remove-correct`: for every labeled `element` case whose answer is a ref, that ref is
  deleted from `view.targets` and the expected answer becomes `none`. A provider that scored above
  the `noop` baseline on the intact corpus **must** lose accuracy on the broken corpus; otherwise the
  evaluator prints a failure and exits non-zero (the guard proves itself).
- `--broken flip-labels` is rejected: flipping labels tests the labels, not the provider.
