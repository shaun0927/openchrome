# Outcome Contract Templates

Reference for the public-web outcome contract template library (A2
thread of #1359). Templates are **data, not behavior** — portable JSON
records that describe *what counts as success* for a recurring
extraction task.

## Why templates

The host LLM picks a template by **id** and the openchrome side never
infers it from a free-text instruction. This keeps openchrome on the
#1359 §P2 (harness, not agent) side of the boundary: openchrome
supplies the primitives (`extract_data`, `oc_evidence_bundle`,
`oc_assert`); the host names the template; the template is JSON.

## The four pre-registered templates

All four ship in the default registry returned by
`getDefaultTemplateRegistry()`. They share `format: 'schema-diff.v1'`
(B1-PR1) and use the same field-type vocabulary.

| `id` | `version` | Tier | Purpose |
|---|---|---|---|
| `public-web.page-meta` | 1 | 1 | Tier-1 page-level meta extraction (title, url, statusCode, description, og:*) |
| `public-web.spa-hydrated` | 1 | 1 | Post-hydration SPA extraction (route, mainContent characterizations, readiness signals) |
| `public-web.link-graph` | 1 | 1 | Site-crawl link-graph extraction (nodes, edges, cardinality, sameOrigin policy) |
| `public-web.authenticated-fields` | 1 | 2 | Post-authentication profile fields (auth posture, gate fact reference, profile fields) |

Each template's full field list lives in `src/contracts/templates/
public-web/<name>.ts`. The repo's tests pin invariants — see
`tests/contracts/templates/public-web/*.test.ts`.

## Host usage recipes

Three openchrome tool surfaces consume templates today.

### 1. `extract_data` — name the template, get the data

```jsonc
{
  "tool": "extract_data",
  "args": {
    "tabId": "<tab>",
    "template_id": "public-web.page-meta"
    // template_version is optional; latest wins
  }
}
```

`extract_data` resolves the template, converts its
`schema-diff.v1` field list into the JSON Schema shape used by the
extractor while preserving the template's observed field names, and
returns the structured result. Inline `schema` still works — when
both are supplied, inline wins.

### 2. `oc_evidence_bundle` — diff the result against the template

```jsonc
{
  "tool": "oc_evidence_bundle",
  "args": {
    "tab_id": "<tab>",
    "include": ["schema_diff"],
    "target_schema": "<template.targetSchema.definition>",
    "evidence": {
      "snapshot": { "observed": "<extract_data.data>" }
    }
  }
}
```

The bundle writer computes the deterministic schema-diff (B1-PR1)
between the observed payload and the schema, writes `schema_diff.json`
to the bundle directory, and echoes the diff in the response. The host
reads `coverage` / `matched` / `missing` / `extra` / `typeMismatch`
and decides what to do — openchrome encodes no threshold.

### 3. `oc_assert` — assertion-tree templates

```jsonc
{
  "tool": "oc_assert",
  "args": {
    "contract_id": "<template.id>",
    "evidence": { "snapshot": { ... } }
  }
}
```

`oc_assert` resolves the template and uses `template.assertions` for
evaluation. The four public-web templates carry **only**
`targetSchema` — no `assertions` — so this call returns inconclusive
with a hint to use `oc_evidence_bundle` with `target_schema` instead.
Custom templates that bundle an assertion DSL tree benefit from this
surface; the public-web catalog is intentionally schema-only.

## Canonical pipeline

The pattern hosts most often want:

```text
extract_data { template_id }                   →  observed
oc_evidence_bundle { target_schema, observed } →  schema_diff
```

A single round-trip:

1. Name the template.
2. Read structured data shaped to the template.
3. Verify coverage with the same template's schema.

External benchmark adapters compose exactly this — see
`examples/external/airena-adapter/README.md` and the canonical
`mapToAirenaRound` mapper in
`tests/external/airena-adapter/map-to-airena.ts`.

## Adding a new template (host-side)

```ts
import { TemplateRegistry } from 'openchrome/contracts/templates';

const r = new TemplateRegistry();
r.register({
  id: 'my-host.product-listing',
  version: 1,
  description: 'Product cards on /shop pages',
  tags: ['my-host', 'commerce'],
  targetSchema: {
    format: 'schema-diff.v1',
    definition: {
      version: 1,
      fields: [
        { name: 'sku', type: 'string' },
        { name: 'price', type: 'number' },
        { name: 'title', type: 'string' },
        { name: 'image', type: 'string', required: false },
      ],
    },
  },
});
```

Hosts that want their templates available through the default registry
should NOT mutate `getDefaultTemplateRegistry()` — instead, instantiate
a fresh `TemplateRegistry`, register the templates that matter for the
host's workflow, and pass the registry to whatever wiring layer needs
it. The default singleton is the openchrome-shipped catalog only.

## Versioning

`(id, version)` is the template's eternal name. Renaming requires
bumping `version`; old versions remain registered forever. This lets
benchmark adapters pin a template version and produce reproducible
results across openchrome releases.

## Out of scope

- The template library does **not** carry credentials, solver keys, or
  any host-specific secrets (#1359 §P7). The `authenticated-fields`
  template enforces this with a negative test — see
  `tests/contracts/templates/public-web/authenticated-fields.test.ts`.
- Inferring the right template from a free-text instruction is the
  host's job. openchrome never auto-selects a template.

## See also

- `src/contracts/templates/` — template source
- `src/contracts/templates/default-registry.ts` — default singleton
- `src/core/contracts/schema-diff.ts` — diff algorithm (B1-PR1)
- `src/core/contracts/promotion-gate.ts` — promotion policy on diffs (B1-PR3)
- `src/tools/oc-evidence-bundle.ts` — `target_schema` consumer (B1-PR2)
- `src/tools/oc-assert.ts` — `contract_id` consumer (A2-PR6)
- `src/tools/extract-data.ts` — `template_id` consumer (A2-PR7)
- `examples/external/airena-adapter/` — external adapter sample
- #1359 §Pillar C (contract-verifiable browser work) + §P2 (harness, not agent)
