# Portability-Harness Contract

## Motivation

OpenChrome already has one documented reliability contract: *"Every tool call MUST
return a result — success or error — within the timeout. OpenChrome never hangs."*
(see `issue-reliability-guarantee.md`). That contract governs **how the server
behaves**.

This document defines a complementary, equally narrow contract that governs **what
the server is allowed to become** as harness features expand. It supersedes the
discussion in issue #768 (`Restructure proposal: core/pilot tier split`); see the
hybrid-resolution comment on that issue for how the two were merged.

As of the 1.11 cleanup cycle, the open PR queue contains five candidate harness
families (trace, skill state graph, outcome contracts, perception primitives,
skill memory) whose unconstrained adoption would compromise two existing
OpenChrome value propositions:

1. **Backward compatibility.** Existing 1.10.4 MCP clients depend on the current
   tool surface behaving exactly as documented. Harness features that mutate that
   surface — by default — break those clients silently.
2. **MCP portability.** OpenChrome's distribution model is `npx openchrome-mcp`
   and the Tauri desktop app. Both rely on the server starting on any modern
   Linux, macOS, or Windows host without external secrets, manual setup, or
   platform-specific compile toolchains. Features that quietly require API keys,
   network egress to third-party LLM providers, or native modules without a
   fallback degrade that "anywhere-compatible" property.

This contract is the design constraint that lets harness work proceed without
eroding either property.

---

## Philosophy

> **OpenChrome is a tool server.** Harness features reinforce the tool-call
> guarantee and the data captured around it. Experimental features that need to
> relax those guarantees ship in a separate `pilot` tier inside the same npm
> package, behind an explicit `--pilot` opt-in CLI flag. The server never trades
> portability for harness richness; *outbound LLM API calls and mandatory
> third-party credentials remain out of bounds even in pilot*.

The contract is narrow and precise by design. It does not dictate which harness
features are valuable. It dictates the conditions under which a harness feature
may ship inside `openchrome-mcp` at all, and which of those features go into
which tier.

---

## Scope

Applies to every PR that:

- adds or modifies a tool, resource, or transport on the MCP surface;
- introduces a new module under `src/core/**` or `src/pilot/**` that is reachable
  from tool dispatch, recorder, or executor paths;
- adds, removes, or pins a runtime dependency in `package.json`;
- modifies `src/index.ts`, `src/core/mcp/**`, `cli/`, or any startup wiring.

Does **not** apply to: documentation-only PRs, CI infrastructure PRs, test-only
PRs that touch no production code.

---

## Principles

These five principles apply at the *project* level. The `core` tier must satisfy
all five strictly; the `pilot` tier explicitly relaxes some of them in exchange
for opt-in status. **Principle P3 (Anywhere-compatible MCP) is the one
principle that pilot also satisfies strictly** — pilot features may add policy
or background work, but they may not introduce outbound LLM API calls or
mandatory third-party credentials.

### P1. Tool server identity

OpenChrome accepts tool calls, executes them, and returns results. It does not
orchestrate multi-step tasks, manage AI agent lifecycles, or operate as a
continuous autonomous loop. Long-lived background work inside the server is
permitted only when it serves a tool-call guarantee (e.g., Chrome process
supervision, CDP reconnection).

The `core` tier enforces this strictly: no work outlives a tool call's lifetime.
The `pilot` tier may run scheduled background work (e.g., the skill curator)
when the operator explicitly enables it via `--pilot`.

### P2. Zero-impact harness extension

A harness feature may add capability, but it must not change the observable
behavior of any tool, resource, transport, or startup sequence that existed in
1.10.4 when the feature is off. "Off" includes:

- the `--pilot` CLI flag is unset (no pilot tools registered at all);
- the per-family sub-flag is unset (the specific family Noops within pilot);
- the feature's optional native dependency failed to load;
- the feature's storage directory is missing or unwritable.

In each "off" condition, the server boots, every 1.10.4 tool call executes, and
`tools/list` / `resources/list` return the 1.10.4 surface exactly.

### P3. Anywhere-compatible MCP

`npx openchrome-mcp setup` and the Tauri desktop installer must succeed on:

- Linux x86_64 (glibc and musl) and aarch64;
- macOS x86_64 and arm64;
- Windows x86_64.

Neither tier may require:

- an outbound HTTP call to any third-party LLM API (Anthropic, OpenAI, Google,
  or comparable) inside the server process — *this restriction applies to both
  core and pilot*;
- a mandatory API key, OAuth token, or vendor credential at boot;
- a platform-specific build toolchain at install time;
- access to OS keychain, Secret Service, or Credential Manager;
- a network-attached secret store.

Server-side LLM-driven decisions (voting, merging, judging) are out of scope for
this repository entirely. They live in separate npm packages or host-side
libraries — see issues #775 and #776.

### P4. Facts versus decisions

OpenChrome captures, computes, stores, retrieves, normalizes, and verifies
facts about browser sessions. It does not make LLM-driven decisions. The host
agent that connects to OpenChrome may make any decision it wants using the
facts the server exposes; the server itself does not call out to language
models or other "judgment" services to interpret captured data.

The `core` tier holds this strictly. The `pilot` tier may encode workflow
policy (retry, escalation, irreversible-action confirmation) but still does not
call LLM APIs (see P3).

### P5. Native dependency discipline

The main `openchrome-mcp` package may declare at most one mandatory native
runtime dependency: `argon2` (required by authentication). Every other native
dependency must satisfy all of the following:

- declared in `optionalDependencies`, not `dependencies`;
- consumed via a lazy `require` guarded by a try/catch fallback that produces a
  Noop or pure-JS implementation;
- documented in `docs/roadmap/native-deps.md` (created when the second native
  dependency is proposed) with the fallback path and the failure surface.

`better-sqlite3` is **not adopted**. Storage layers that previously assumed it
use JSONL or JSON files plus `proper-lockfile` for concurrent-write coordination
(the project already ships `src/utils/atomic-file.ts` which provides this).

---

## The core / pilot tier model

OpenChrome's source tree is split into two tiers within the same npm package
and the same CLI binary.

### Source layout

```
openchrome/
├── src/
│   ├── core/                             ← P1–P5 strictly enforced
│   │   ├── trace/                        session recorder, JSONL storage, CDP hooks
│   │   ├── skill/                        state hashing, JSON skill graph, read-only API
│   │   ├── contracts/                    DSL, oc_assert, oc_evidence_bundle, pHash, screenshot class
│   │   ├── perception/                   DOM metadata, Sobel+color cross-check
│   │   ├── skill-memory/                 JSON store + audit-log stats (no extractor)
│   │   ├── cli/                          oc trace, oc skill inspect, oc trace play
│   │   └── mcp/                          server, transport, resource registry
│   └── pilot/                            ← P1 relaxed (background work), P4 relaxed (policy)
│       ├── executor/                     graph executor with resume-from-state
│       ├── runtime/                      contract runtime, retry, idempotency, beforeIrreversibleAction
│       ├── handoff/                      handoff token + AES-256-GCM persistence
│       ├── voting/                       Voter interface + deterministic implementations (no LLM)
│       ├── curator/                      structural skill curator (no LLM merge)
│       └── index.ts                      lazy bootstrap, registered only when --pilot
├── tests/
│   ├── core/                             required for every PR
│   └── pilot/                            required only when src/pilot/ changes
├── docs/
│   ├── roadmap/portability-harness-contract.md   this document
│   ├── roadmap/openchrome-1.11-cleanup.md        one-time application plan
│   └── pilot/README.md                            experimental tier user docs
└── package.json
```

### Import direction (enforced by lint)

- `src/core/**` may **not** import from `src/pilot/**`.
- `src/pilot/**` **may** import from `src/core/**`.
- Enforced via `dependency-cruiser` rule in CI. Configuration ships with the
  PR that lands this contract document.

### CLI surface

- `openchrome serve` — registers tools from `src/core/` only. Exact behavior
  of v1.10.x is preserved bit-for-bit.
- `openchrome serve --pilot` — bootstraps `src/pilot/` too. Pilot tools carry
  an `oc_pilot_` prefix or live under `openchrome://pilot/...` resources so the
  experimental nature is visible to MCP clients.
- `openchrome serve --pilot --pilot-features=trace,state_graph` — optional
  per-family sub-flag for finer-grained activation within pilot. When omitted,
  all pilot families register.
- `npx openchrome install <feature>` — convenience to install missing
  `optionalDependencies` for a named pilot feature. Used by pilot's friendly
  fallback prompts.

The `--pilot` flag is the *only* user-facing change for opting into the
extended harness. Adding it to an existing config flips features on; removing
it flips them off. There is no second `npm install`, no second package, no
separate config file.

### Two-stage CI

- **Stage 1** (mandatory on every PR): `npm test -- tests/core`. This is the
  gate for every PR regardless of tier.
- **Stage 2** (mandatory only when `src/pilot/**` is touched):
  `npm test -- tests/pilot`. PRs that don't touch pilot don't pay this cost.

### Tier labels

GitHub labels:

- `tier:core` (color `0e8a16`) — "Lives in src/core/, must satisfy P1-P5
  strictly"
- `tier:pilot` (color `fbca04`) — "Lives in src/pilot/, opt-in via --pilot,
  P1/P4 relaxed but P3 still enforced"

Every open issue (#701–#734) and every PR carries exactly one tier label after
this contract merges.

### Per-feature sub-flags (inside `--pilot`)

| Family | Sub-flag | Default when `--pilot` is set |
|---|---|---|
| Trace recorder | `--pilot-features=trace` or `OPENCHROME_TRACE=1` | active |
| Skill state graph | `--pilot-features=state_graph` or `OPENCHROME_STATE_GRAPH=1` | active |
| Contract runtime (retry, escalation) | `--pilot-features=runtime` or `OPENCHROME_CONTRACT_RUNTIME=1` | active |
| Handoff persistence | `--pilot-features=handoff` or `OPENCHROME_HANDOFF_PERSIST=1` | active (in-memory only by default; see below) |
| Perception extras (voting framework) | `--pilot-features=perception_pilot` or `OPENCHROME_PERCEPTION_VOTING=1` | active |
| Skill curator | `--pilot-features=skill_curator` or `OPENCHROME_SKILL_CURATOR=1` | active |

`core`-tier features (trace primitives, pHash, screenshot class, perception
primitives, skill-memory store, audit-log stats) are *always* registered and
need no flag — they ship inside `serve` without `--pilot`.

When `--pilot` is unset, none of the above sub-flags or env variables have any
effect; the pilot bootstrap module is never loaded.

### Skill state graph — v1 algorithm

The `state_graph` family (`OPENCHROME_STATE_GRAPH=1`, default-on inside
`--pilot`) ships a deliberately narrow v1 hash: `sha256("v1\0" + origin +
pathname).hex.slice(0, 16)`. Query strings, fragments, and trailing
slashes on non-root pathnames are discarded; the host is lower-cased and
the path stays case-sensitive. Pathname-only hashing differentiates
pages but not states within a page — folding a coarse DOM skeleton
(tag tree + ARIA landmarks + form/button counts) into the canonical
input lands in a follow-up PR. When that ships, `STATE_HASH_VERSION`
rolls to `v2`; the `state_hash_version` field emitted alongside every
`TransactionRecord.state_hash` lets curator migrations and dashboards
distinguish algorithm generations without re-parsing historical
frontmatter.

When the family flag is off (either `--pilot` is unset or
`OPENCHROME_STATE_GRAPH=0` is set explicitly), `runWithContract` emits
records without `state_hash` / `state_hash_version`, preserving 1.10.4
audit-pipeline byte-parity.

---

## Handoff token encryption (#755 family)

The handoff token persistence layer (pilot tier) encrypts tokens with
AES-256-GCM. The encryption key is **ephemeral by default** — it lives in
process memory and is regenerated on every server start, which invalidates any
persisted handoff tokens from prior runs. Operators wanting cross-restart
persistence set `OPENCHROME_HANDOFF_KEY_FILE=<path>`; the file contains a
32-byte key, loaded at boot, never logged, never embedded in audit records.

No OS keychain integration is provided (P3 prohibits it). Issue #721, which
proposed macOS Keychain + Windows Credential Manager adapters, is superseded by
this policy.

---

## Release sequencing

Three-step rollout aligned with the tier split:

- **v1.11.0 — core tier complete, pilot stub.** All core-tier PRs from §8 of
  `openchrome-1.11-cleanup.md` land. `--pilot` flag exists but registers nothing
  (empty bootstrap). Users who run `openchrome serve` see the full extended
  core feature set: trace recorder, JSON skill graph (read-only), pHash,
  screenshot class, perception primitives, skill-memory store + stats, new
  `oc_assert` / `oc_evidence_bundle` / `oc_skill_record` / `oc_skill_recall`
  tools.
- **v1.12.0 — pilot tier experimental.** Pilot PRs land into `src/pilot/`.
  README and CHANGELOG label pilot as experimental. SemVer minor — breaking
  changes are still allowed inside pilot.
- **v1.13.0 — pilot tier stable.** Pilot tools become semver-stable. Epic
  acceptance criteria from #698–#700 and #712 are satisfied.

---

## PR review checklist

Every PR matching the scope above must demonstrate the following in its body
or in the diff:

- [ ] **Tier declaration.** PR body states `tier:core` or `tier:pilot` and the
      target directory under `src/core/**` or `src/pilot/**`.
- [ ] **Facts, not decisions.** The PR adds capability that is descriptive,
      computational, or storage-oriented. It does not call an LLM API from the
      server. If the PR adds a `Voter` or similar interface, at least one
      deterministic implementation accompanies it.
- [ ] **Off behavior.** When `--pilot` is unset (and any relevant sub-flag is
      unset), every code path added by this PR is unreachable from tool
      dispatch, recorder, and executor. A test or trace demonstrates this.
- [ ] **No new mandatory native dependency.** `package.json` changes do not
      add anything to `dependencies` beyond `argon2`. New native modules, if
      any, are in `optionalDependencies` with a documented fallback.
- [ ] **No mandatory API key, network egress, or vendor credential.** Boot
      succeeds with all third-party LLM provider variables unset. The PR
      does not introduce outbound calls to LLM APIs (this restriction is
      identical for core and pilot).
- [ ] **1.10.4 surface preserved.** `tools/list` and `resources/list` return
      the 1.10.4 set when `--pilot` is unset (modulo unflagged additions
      enumerated in the cleanup doc).
- [ ] **Reliability contract not regressed.** Tool-call timeout behavior is
      unchanged. Any new path that could block the event loop has an explicit
      bound.
- [ ] **Import direction respected.** No import from `src/core/**` to
      `src/pilot/**`. dependency-cruiser CI gate passes.

PRs failing any item must be modified before merge. PRs that cannot satisfy
the "no outbound LLM call" requirement of P3 are out of scope and should be
moved to a separate package or host-side library; close-with-redirect is the
expected outcome.

---

## Non-goals

- This contract does not impose a feature roadmap. It does not require any
  optional family to ship; it only specifies the conditions under which they
  may.
- It does not promise zero-config across all features. With `--pilot` unset the
  server is zero-config; enabling pilot is the operator's act.
- It does not duplicate the reliability contract. Where they overlap (e.g.,
  P1, the no-event-loop-block checklist item) the reliability contract is the
  authoritative source.
- It does not adopt OS keychain / Secret Service / Credential Manager
  integration. Operators wanting durable handoff persistence use a key file
  they manage themselves.

---

## Document status

Normative. Every PR landing on `develop` after this document merges must satisfy
the checklist. Application to the 35 currently-open PRs is tracked in
`openchrome-1.11-cleanup.md`.

References:
- `docs/roadmap/issue-reliability-guarantee.md` — the reliability contract this
  document complements.
- Issue #768 — the original `core/pilot` restructure proposal; superseded by
  this contract (hybrid resolution adopted 2026-05-12; see comment thread).
- Issues #775, #776 — separate-package extractions for server-side LLM features
  rejected by P3.
- Issues #777, #778, #779, #780 — supporting infrastructure issues for this
  cleanup cycle.
