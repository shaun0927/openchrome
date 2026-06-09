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

**Opt-in (original ship, #1376/#1379).** A shared broker was engaged only when an
operator explicitly passed `--broker` (the owner) and `--connect-broker` (the
forwarding client). The default stdio path did **not** auto-join a broker; two
plain `openchrome` invocations against the same `(port, userDataDir)` collided on
the controller lock (the second failed fast with `process.exit(2)`) rather than
silently sharing. This kept the simple single-client case dependency-free and
made sharing a deliberate act.

#### Amendment — auto-elect coordinated sharing path (Q1′, 2026-06-08)

**Superseded target for the `serve --auto-launch` path: OpenChrome should converge
on coordinated auto-elect sharing instead of fail-fast surplus sessions.** The
initial implementation is intentionally guarded by `--auto-elect` /
`OPENCHROME_AUTO_ELECT=1`; flipping that path to the default remains a separate
release decision after S2–S4 validation. Recorded after the parallel-session
regression report ([#1474](https://github.com/shaun0927/openchrome/issues/1474))
and root-cause tracking ([#1480](https://github.com/shaun0927/openchrome/issues/1480)).

Rationale. The fail-fast default delivered safety (one CDP owner per
`(port, userDataDir)`, per #1367) but **regressed a previously-working topology**:
before [#1376](https://github.com/shaun0927/openchrome/pull/1376) (commit
`664ffa36`, closes [#1367](https://github.com/shaun0927/openchrome/issues/1367)),
the second `--auto-launch` process attached to the already-running Chrome on the
port, so N host sessions shared one browser and all worked. #1367's own conclusion
names the safe end-state explicitly:

> "Multiple sessions may share a Chrome/profile, but they must do so through **one
> coordinated owner/broker**, not through multiple independent controllers."

Auto-elect *is* that end-state. The #1480 implementation first wires it as an
explicit opt-in (`--auto-elect`) so the behavior can be validated before any
default flip:

- The `--auto-launch` process that **wins** the controller lock becomes the broker
  **owner** (it alone runs Chrome lifecycle, the watchdog, and CDP cleanup) and
  publishes broker discovery metadata under `~/.openchrome/brokers/`.
- A process that **loses** to a *healthy* owner does **not** `exit(2)`; it
  auto-switches to a `--connect-broker` **client**, forwarding its stdio MCP
  traffic to the owner. Clients own no lifecycle, so the multi-independent-controller
  races #1367 prevented (stale targets, accidental tab closure, reconnect races)
  **cannot recur**.
- A process that finds a **half-zombie** owner (lock held, CDP dead) takes the lock
  over and promotes itself
  ([#1477](https://github.com/shaun0927/openchrome/pull/1477)); on owner death a
  surviving client re-elects
  ([#1478](https://github.com/shaun0927/openchrome/pull/1478) self-release + lock
  takeover), removing the single-point-of-failure.

This is **not** a return to silent multi-controller sharing: there is still exactly
**one** direct CDP owner per `(port, userDataDir)`; the change is that surplus
sessions become *coordinated clients of that one owner* instead of being rejected.
Manual `--broker` / `--connect-broker` remain valid and unchanged for operators who
want to place the owner explicitly (e.g. a long-lived daemon). The only path that
still permits multiple *independent* direct controllers is the loud debug escape
`--allow-unsafe-shared-attach` / `OPENCHROME_ALLOW_UNSAFE_SHARED_ATTACH=1`, which
keeps the documented race warning.

Boundary check against the SSOT non-identity (#1359): auto-elect introduces **no
hidden host-specific behavior** — election is host-neutral, decided purely by the
`(port, userDataDir)` controller lock and the broker discovery file, and every
outcome (owner / client / takeover / refusal) is surfaced over portable MCP
surfaces, not host-coded.

> **Status:** decided as the target topology; implementation in flight under #1480.
> The controller lock, broker discovery, and stdio proxy primitives are already on
> `develop`; the S2 owner auto-publish → S3 client auto-connect → S4 re-election
> wiring is stacked on the #1474 reliability fixes (#1477 → #1478 → #1479). Until
> an explicit default-flip PR lands, plain `serve --auto-launch` remains fail-fast
> and coordinated sharing requires `--auto-elect` (or manual `--broker` /
> `--connect-broker`). Treat this section as the normative target and rollout plan,
> not as a claim that the default has already flipped.

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

## D4. Auto-retry semantics (reliability scope)

Recorded as part of the post-ship reliability audit (2026-06-02). Promotes an
implicit behavior in `src/mcp-server.ts` to a normative decision so it is not
"fixed" in the wrong direction by future contributors.

**Decision.** OpenChrome's built-in auto-retry of a tool call is **connection-error
only** and is **at-least-once**, not at-most-once:

1. A retry is attempted only when the failure is classified as a connection error
   (`isConnectionError`). Non-connection failures are surfaced as-is, never retried.
2. The thrown-error retry path is gated on a successful
   `sessionManager.reconcileAfterReconnect()`; if reconciliation fails the retry is
   aborted and the **original** error is returned (stale target state must not drive
   a retry).
3. Because a connection can drop *after* a side effect was dispatched to Chrome but
   *before* its acknowledgement, a side-effectful tool (e.g. a form submit) may
   execute twice across the drop+retry. This at-least-once window is **accepted**:
   **at-most-once / idempotency for arbitrary actions is the orchestrator's
   responsibility** (see the Responsibility Boundary and Non-Goals in
   `issue-reliability-tracking.md`). OpenChrome offers only an opt-in
   `idempotencyKey` for callers that need dedup.
4. Both retry paths (thrown error and swallowed-error-in-result) **must** apply the
   same guards: a timeout race around the retried handler and the reconcile gate.
   The swallowed-error path historically omitted both, **and was in fact dead code**:
   it gated on `isConnectionError({ message: errorText })`, but `isConnectionError`
   stringifies non-`Error` values via `formatError` → `String(value)`, so the plain
   object became `"[object Object]"` and matched no pattern, meaning the retry never
   fired. Fixed in PR #1471 (issue #1469 / "Known Limitations / L1" in
   `issue-reliability-guarantee.md`): pass the string directly, then apply the same
   reconcile gate and timeout race as the thrown-error path. This is the normative
   shape; any future divergence is a bug.

## D5. Timeout / abort cancellation semantics

Recorded 2026-06-02. Promotes the doc comment in `src/utils/with-timeout.ts` to a
normative decision.

**Decision.** On a tool-execution timeout or a client `AbortSignal`, OpenChrome
**returns immediately and does not guarantee cancellation of the in-flight CDP
command.** The underlying operation may continue to completion in the background
(an "orphaned background call"), so a side effect may land *after* a timeout/abort
error was already returned ("ghost effect"). This residual risk is **consciously
accepted** in favour of the never-hang contract — bounding caller latency takes
priority over guaranteeing downstream cancellation. Per-tool best-effort
cancellation (propagating the signal into specific CDP/Puppeteer calls and
reconciling page state afterward) is a **future improvement, not part of the
contract**.

---

## Still open

- The C6 perf/console **assertion kinds** (audit #1457) are deferred to a
  dedicated follow-up: they extend the `EvalContext` contract with console/perf
  seams, larger than the failure-category surfacing landed in PR-5.
- Skill-store reconciliation + provenance (audit #1457 PR-4) is in progress; this
  file's D2 naming applies once that lands.
