# SSOT decisions log

Resolutions for the open questions in the product-direction SSOT
([#1359](https://github.com/shaun0927/openchrome/issues/1359)), recorded as part
of the pillar gap audit ([#1457](https://github.com/shaun0927/openchrome/issues/1457)).

This file is normative for the questions it answers. When the SSOT issue and this
file disagree, this file is the more recent decision; update the SSOT issue to
match.

---

## D1. pilot → core graduation criteria (SSOT open question #3)

A `src/pilot/**` feature family graduates to `src/core/**` only when **all** of
the following hold. This is the gate that lets verified-memory and contract
machinery move out of the experimental tier without eroding the
portability-harness contract.

1. **P1–P5 strict with pilot off.** With `--pilot` unset the feature is fully
   unreachable today; after graduation its always-on form must still satisfy
   every principle in `docs/roadmap/portability-harness-contract.md` strictly —
   in particular **no outbound LLM API calls and no mandatory third-party
   credentials** (P3), and **facts, not server-side decisions** (P4).
2. **Zero-impact preserved.** The 1.10.4 `tools/list` / `resources/list` surface
   and every existing tool's observable behavior are unchanged by the graduation
   (the feature adds capability, it does not mutate existing contracts).
3. **Core-tier test coverage.** Tests move from `tests/pilot/**` to
   `tests/core/**` and run in CI Stage 1 (the mandatory gate), not only Stage 2.
4. **Stable schema for ≥ 1 minor.** Any MCP tool/resource the feature exposes has
   kept a backward-compatible schema for at least one published minor release
   while in pilot.
5. **Unknown-client fallback.** The feature has a documented deterministic
   fallback when optional client capabilities (`sampling`, `elicitation`,
   `roots`, `tools/list_changed`) are absent.
6. **Tier boundary clean.** No `src/core/**` → `src/pilot/**` import is introduced
   (enforced by `lint:tier` / dependency-cruiser).

**Process.** A graduation PR carries the `tier:core` label, moves the source from
`src/pilot/<family>/` to `src/core/<family>/`, moves its tests, drops the
`--pilot` sub-flag (the family becomes always-on), and updates this file with the
graduation date and the commit that satisfied each criterion above. A graduation
must be its own PR — no behavior change may ride along.

No family has graduated yet.

---

## D2. Name of the verified-memory loop (SSOT open question #4)

The contract-verified skill/selector memory loop is named the
**Verified Skill Loop (VSL)**.

Definition: a skill or selector record becomes VSL-eligible only when it is
extracted from a **contract-verified** successful run (an `oc_assert` /
runtime postcondition that passed), carries explicit **provenance**, and is
surfaced to host agents as **recallable context** — never auto-executed
(`docs/tools/skill-recall-ranking.md`). VSL is the umbrella term used in docs,
issues, and PR descriptions for this loop; the implementing modules remain
`src/core/skill-memory/**` (store + stats) and `src/pilot/curator/**`
(extraction), pending the store reconciliation tracked under #1457 PR-4.

---

## D3. Shared-profile broker decisions (SSOT "updated open questions")

These record the shipped broker/parallelism behavior so it is no longer an open
question.

### Broker default vs. opt-in (Q1)

**Opt-in.** A shared broker is engaged only when an operator explicitly passes
`--broker` (the owner) and `--connect-broker` (the forwarding client). The
default stdio path does **not** auto-join a broker; two plain `openchrome`
invocations against the same `(port, userDataDir)` collide on the controller
lock (the second fails fast) rather than silently sharing. This keeps the simple
single-client case dependency-free and makes sharing a deliberate act.

### Local discovery mechanism (Q2)

**A discovery file under `~/.openchrome/brokers/`** (see
`src/broker/discovery.ts`), keyed by the normalized `(port, userDataDir)`. A
`--connect-broker` client reads that file to locate the owner's HTTP endpoint and
forwards its stdio MCP traffic there. No network broadcast or port scanning is
used.

### Lease expiry policy (Q4)

**Sliding idle TTL.** The decided policy is: a managed target lease expires only
after its owner has been silent for `targetLeaseTtl` (default 30 minutes; `0`
disables). Every `executeCDP` call slides the deadline forward, so an actively
used tab is never reclaimed — only a disconnected/crashed owner's lease reaches
expiry, at which point the orphaned tab is reclaimed. The **`default` session is
exempt** (mirrors the existing `sessionTTL` protection) so a single-agent
workflow's tabs persist, and `preserve`-policy leases are never auto-closed. This
resolves the SSOT worry that an absolute TTL would kill long-running agent tasks.

> **Status:** decided, implementation in flight. The `TargetLeaseRegistry`
> primitive (`expire()`, `leaseExpiresAt`) is already on `develop`, but no caller
> passes `ttlMs` to `acquire()` yet, so expiry is inert until the sliding-TTL
> wiring lands (audit #1457 PR-3 / #1460, still open). Treat this section as the
> normative target the wiring PR must satisfy, not as shipped `develop` behavior.

### Multi-tenant default (Q6)

**Require explicit trust configuration.** Shared-profile mode does not treat
multiple clients as mutually trusted by default; cross-tenant sharing over one
profile requires explicit opt-in (see the "Shared-profile broker trust model"
section of [`docs/mcp/topologies.md`](../mcp/topologies.md)). The safe default for
independent trust boundaries remains separate `--port` / `--user-data-dir`
profiles.

---

## Still open

- The C6 perf/console **assertion kinds** (audit #1457) are deferred to a
  dedicated follow-up: they extend the `EvalContext` contract with console/perf
  seams, larger than the failure-category surfacing landed in PR-5.
- Skill-store reconciliation + provenance (audit #1457 PR-4) is in progress; this
  file's D2 naming applies once that lands.
