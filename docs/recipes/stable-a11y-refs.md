---
doc_kind: project-material
status: working
version: 2026-07-21_v1
canonical_path: /home/elite/projects/tools/references/openchrome-fork-b2/docs/recipes/stable-a11y-refs.md
---

# Stable a11y-refs across reloads

Openchrome's DOM serializer prefixes each node with `backendNodeId`
(`[123]<button ... />`). That id is stable inside a single page load
but churns on reload, back/forward, or client-side re-hydration. Any
plan the agent cached against `[123]` is stale the next tick.

This recipe uses `src/dom/stable-ref.ts` to mint content-addressed
refs that survive reload as long as the target element's identity
signature stays the same.

## When to use

- The agent is executing a plan across multiple page loads (login →
  checkout → confirmation).
- You want to reuse a `storage_state` snapshot and have the "same"
  refs on the reloaded page as on the original.
- Two identical-looking siblings (list rows, product cards) need to
  be told apart deterministically.

## Minting refs

```ts
import { mintPageRefs } from 'openchrome-mcp/dist/dom/stable-ref';

const refs = mintPageRefs([
  { tag: 'button', role: 'button', name: 'Sign in',
    ancestorTags: ['html', 'body', 'form'], siblingIndex: 0 },
  { tag: 'input', role: 'textbox', name: 'Email',
    ancestorTags: ['html', 'body', 'form'], siblingIndex: 1,
    stableAttr: 'email-input' },
]);

// refs[0].display === '@e' + 6-hex-char hash
// refs[1] shares hash even after reload — stableAttr dominates
```

## Storage-state reuse

Persist `{ url, ref }` alongside the storage_state snapshot; look up
with `refKey({ url, ref })`. Query strings and hash fragments are
stripped so the same element on `/checkout?ref=abc` and `/checkout`
resolves to the same key.

```ts
import { refKey } from 'openchrome-mcp/dist/dom/stable-ref';

const key = refKey({ url: page.url(), ref: refs[0].hash });
// key === 'https://x.com/checkout#<hash>'
storageState.pins[key] = { selector: 'button[type=submit]', role: 'button' };
```

## Design notes

- Hash is truncated SHA-256, default 6 hex chars (~24 bits). Collisions
  are resolved by `mintPageRefs()` with deterministic suffixes
  (`b`, `c`, `d`..., wrapping to two letters after 25).
- `stableAttr` (data-testid, non-generated `id`, `name`) dominates the
  hash. When present, tree coordinates are secondary — the ref survives
  DOM reorganisation.
- Reserved ARIA roles (`generic`, `none`, `presentation`, empty) are
  collapsed to empty so the browser's role-computation choice doesn't
  perturb the hash.
- Unicode whitespace (nbsp, zero-width space) is normalised so a
  browser that inserts `&nbsp;` on one load and a space on the next
  still produces the same ref.

## Origin credit

Shared idiom from playwright-mcp (Apache-2.0, `aria-ref`) and Vercel's
agent-browser (Apache-2.0, `@e*`). Clean-room implementation in
`src/dom/stable-ref.ts`.
