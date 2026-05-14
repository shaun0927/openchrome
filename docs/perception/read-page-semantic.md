# `read_page` semantic mode

`read_page { mode: "semantic" }` is a deterministic, LLM-free page-state
projection for host agents that need compact state plus available actions. It is
additive: existing `dom`, `ax`, `css`, and `markdown` modes are unchanged.

## When to use

Use semantic mode when the host needs to decide what to do next on a page but
does not need full HTML or a raw accessibility tree. The response groups DOM/AX
content into regions such as product cards, forms, navigation, articles, lists,
media, or generic actionable areas.

```json
{
  "tabId": "<tab-id>",
  "mode": "semantic"
}
```

## Response shape

The response is a JSON document with page metadata, regions, and refs:

```ts
interface SemanticView {
  url: string;
  title: string;
  regions: SemanticRegion[];
  refs: Record<string, RefEntry>;
  aria?: { tree_empty?: boolean };
}

interface SemanticRegion {
  id: string;
  kind: 'product' | 'form' | 'navigation' | 'article' | 'media' | 'list' | 'generic';
  label: string;
  state: Record<string, string>;
  actions: SemanticAction[];
  ref_ids: string[];
}

interface SemanticAction {
  verb: 'click' | 'fill' | 'select' | 'navigate' | 'submit';
  target: string;
  ref_id: string;
}
```

`refs` uses the same ref entry shape as the rest of OpenChrome's ref-aware page
state. Ref identifiers returned by semantic mode are intended for immediate use
with ref-aware tools such as `computer`, `interact`, or form helpers; stale refs
should be handled with the normal structured stale-ref error path.

## Deterministic rules

Semantic mode is implemented by `src/core/perception/semantic.ts` and the
version-pinned rule file `src/core/perception/semantic-rules.json`.

High-level behavior:

1. Walk the AX/DOM snapshot depth-first.
2. Promote meaningful subtrees (`article`, `form`, `listitem`, `navigation`,
   `region`, `main`, and matching DOM tags) into region candidates.
3. Collapse repetitive sibling regions into a list when they share the same
   top-level role structure and exceed the rule-set threshold.
4. Classify region kind using committed rules, not a model call.
5. Extract compact state (`heading`, `summary`, price/title fields where rules
   identify them) and deterministic actions from descendant controls.

No server-side LLM, hosted browser runtime, or external HTTP client is used in
this code path.

## Empty AX-tree policy

If the accessibility tree is empty, semantic mode returns an empty but valid
response instead of waiting or polling:

```json
{
  "url": "...",
  "title": "...",
  "regions": [],
  "refs": {},
  "aria": { "tree_empty": true }
}
```

Callers should use existing `wait_for` or another readiness check before trying
again if the page is still loading or canvas-only.

## Token budget contract

Semantic mode is designed to be materially smaller than DOM output on the pinned
perception fixtures:

- Aggregate `semantic_bytes / dom_bytes <= 0.40`
- No single fixture exceeds `0.65`

The fixture set lives under `tests/fixtures/perception/` and is checked by
`tests/core/perception/semantic.token-budget.test.ts`.

## Verification anchors

- Pure semantic builder: `tests/core/perception/semantic.test.ts`
- Token budget: `tests/core/perception/semantic.token-budget.test.ts`
- Fixtures: `tests/fixtures/perception/*.html`
- Tool dispatch/schema: `src/tools/read-page.ts`
- Rule set: `src/core/perception/semantic-rules.json`
