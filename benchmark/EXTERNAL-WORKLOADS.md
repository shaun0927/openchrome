# External Benchmark Workloads

Catalog of *external* benchmark workloads that consume openchrome through
its **public MCP surfaces** without being part of the openchrome build
graph. These workloads validate that openchrome's fact-emission surfaces
(schema-diff, gate-inspect, fingerprint, path-taken) compose with
third-party scoring systems — i.e. that openchrome's claimed
host-neutrality (#1359 §P1) holds in practice.

## Difference vs `benchmark/`

| `benchmark/` (in-tree) | `examples/external/` (out-of-tree) |
|---|---|
| Run by openchrome CI | Run by the external benchmark host |
| Failures gate openchrome PRs | Failures do not gate openchrome |
| Built from openchrome internals | Composed of public MCP tool calls only |
| Maintained by openchrome | Maintained by the workload owner |

This file lists *registered* external workloads — adapters whose pure
mapping logic (the openchrome → workload-shape transform) lives in
`examples/external/<name>/` and whose mapper tests pass under
`npx jest examples/external/<name>/`.

## Registered workloads

### airena.lol

- **Scope:** crawler-arena style benchmark scoring (round-based).
- **Adapter:** `examples/external/airena-adapter/`
- **Status:** sample.
- **Mapping logic:** `examples/external/airena-adapter/map-to-airena.mjs`
- **Tests:** `examples/external/airena-adapter/map-to-airena.test.mjs`
- **MCP surfaces consumed:**
  - `extract_data` (with public-web templates from
    `src/contracts/templates/public-web/`)
  - `oc_evidence_bundle` (with `target_schema` from B1-PR2)
  - `oc_gate_inspect` (B2-PR1 + B2-PR2)
  - `oc_profile_fingerprint` (B3-PR2)
- **Pillar coverage:** C (facts), E (benchmark anchoring)

## How to register a new workload

1. Pick a host-neutral name (no openchrome-internal references in the
   directory or README).
2. Add a directory under `examples/external/<name>/`:
   - `README.md` — what the workload does, what MCP surfaces it
     consumes, how to run it (out of scope here).
   - `map-to-<workload>.mjs` — **pure mapping function** from
     openchrome facts to the workload's score envelope.
   - `map-to-<workload>.test.mjs` — Jest tests on the mapper alone
     (no MCP transport, no network).
   - `adapter.mjs` — sample wire-up (untested transport, host runs it
     themselves).
3. Append an entry above with the same fields.

## #1359 alignment

- **§P1** (host-neutral MCP first): external workloads MUST consume
  only public MCP tool calls. No imports from `src/` allowed in
  `examples/external/`.
- **§P4** (facts before decisions): the openchrome side emits facts
  only. The mapper turns facts into a host-shaped score envelope.
  Any scoring threshold lives in the mapper, not in openchrome.
- **§P5** (evidence before claims): claims about competitive
  performance against an external workload must cite a reproducible
  run through that workload's adapter, with the openchrome version
  pinned.
