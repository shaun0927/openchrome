# airena-adapter (sample external benchmark adapter)

A minimal reference implementation showing how a third-party benchmark
scorer (`airena.lol`) consumes openchrome via its **public MCP surfaces**
— without any openchrome core changes.

**Scope:** sample. Not shipped, not required, not on the build graph.
Lives in `examples/` so the openchrome core stays #1359 §P1 compliant
(host-neutral MCP first; no host-specific behavior in core).

## What it demonstrates

The adapter glues together four public openchrome MCP tools to produce
exactly the JSON shape that `airena.lol`'s `/api/round` endpoint
expects:

| openchrome surface | Role |
|---|---|
| `extract_data` (with one of the public-web templates from `src/contracts/templates/public-web/`) | Produces the structured observed payload |
| `oc_evidence_bundle` (with `target_schema` from B1-PR2) | Computes schema-diff coverage as a fact |
| `oc_gate_inspect` (from B2-PR1/PR2) | Captures the gate fact alongside the result |
| `oc_profile_fingerprint` (from B3-PR2) | Identifies the auth session, secret-free |

The adapter then maps openchrome's facts to airena's scoring envelope.
Nothing in this pipeline reaches into openchrome internals.

## #1359 alignment

This sample is the **canonical demonstration** of the boundary called
out in #1359:

> openchrome emits facts; external scorers / benchmark harnesses turn
> facts into scores.

The adapter lives in `examples/`. The benchmark harness for openchrome
(`benchmark/`) refers to it via the new registry file
`benchmark/EXTERNAL-WORKLOADS.md` but never imports the adapter into
its build graph. Hosts that want a different scorer (e.g.
`crawler-arena.dev`) clone this directory and swap the mapping
function.

## Files

The sample source and tests live under `tests/external/airena-adapter/`
so the repo's tsconfig and jest config can pick them up without a
separate test scaffold; this `examples/` directory is README-only.

- `tests/external/airena-adapter/adapter.ts` — the glue.
- `tests/external/airena-adapter/map-to-airena.ts` — pure function:
  openchrome facts → airena scoring envelope. Unit tests cover this
  without needing the real MCP transport.
- `tests/external/airena-adapter/map-to-airena.test.ts` — Jest tests.

## Running (out of scope here)

`adapter.mjs` is a stub showing the wire-up. Actually executing it
requires an openchrome MCP server, a tab with content, and an
airena.lol REST endpoint. The mapping logic in `map-to-airena.mjs` is
fully testable in isolation — that's where the load-bearing surface
lives.

## Caveats

- Sample only. No CI gate. Breaking it does not break openchrome.
- airena.lol's REST shape is host-defined and may change; the
  mapping function is the single point that needs updating.
- This is not the right place to add openchrome features. If the
  adapter needs an openchrome change, the change belongs in
  openchrome core under a separate PR — never under `examples/`.

## See also

- `src/core/contracts/schema-diff.ts` (B1-PR1) — the source-of-truth
  diff facts the mapper reads.
- `src/contracts/templates/public-web/*.ts` (A2-PR2..5) — canonical
  target schemas.
- `src/tools/oc-gate-inspect.ts` (B2-PR1/PR2) — fact-only gate
  detection.
- `src/storage-state/fingerprint.ts` (B3-PR1) + `oc_profile_fingerprint`
  (B3-PR2).
- `benchmark/EXTERNAL-WORKLOADS.md` — registry entry.
- `docs/roadmap/portability-harness-contract.md` §P1.
