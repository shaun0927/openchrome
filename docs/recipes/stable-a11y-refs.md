---
doc_kind: project-material
status: working
version: 2026-07-21_v2
---

# Stable a11y-refs across reloads

`read_page` (DOM mode) emits a `[node_refs]` block. Each line is now:

    <backendNodeId>=<per-load-uid> stable=@e<hash>

`stable=@e<hash>` is the reload-stable content-addressed ref. Two
identical elements at the same DOM slot hash to the same `@e<hash>`
across page reloads, back/forward navigation, and client-side
re-hydration; the per-load uid and `backendNodeId` do not.

## Where it comes from

`src/dom/dom-serializer.ts` walks the DOM, tracks each node's tag,
role, name, ancestor tag chain, and sibling index, and calls
`computeStableRef()` (`src/dom/stable-ref.ts`). Test-hook attributes
(`data-testid`, `data-cy`, `data-qa`, `data-id`, `name`, and
non-generated-looking `id`) dominate the hash so a labelled element
keeps its ref even when re-parented.

## Storage-state reuse

Cache plans against `stable=@e<hash>`, not `backendNodeId`. Use
`refKey({ url, ref })` from `src/dom/stable-ref.ts` as the composite
lookup key; query strings and hash fragments are stripped.

## Notes

- Hash is truncated SHA-256, default 6 hex chars (~24 bits). Measured
  collision rate on 200 realistic-mix nodes: 0% (see
  `tests/dom/stable-ref-integration.test.ts`).
- Reserved ARIA roles (`generic`, `none`, `presentation`, empty)
  collapse to empty so browser role-computation drift doesn't perturb
  the hash.
- Unicode whitespace (nbsp, zero-width space) is normalised so a
  browser that inserts `&nbsp;` on one load and a space on the next
  produces the same ref.

## Origin credit

Shared idiom from playwright-mcp (Apache-2.0, `aria-ref`) and Vercel's
agent-browser (Apache-2.0, `@e*`). Clean-room implementation.
