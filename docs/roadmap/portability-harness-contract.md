# Portability-Harness Contract

## Motivation

OpenChrome already has one documented reliability contract: *"Every tool call MUST
return a result — success or error — within the timeout. OpenChrome never hangs."*
(see `issue-reliability-guarantee.md`). That contract governs **how the server
behaves**.

This document defines a complementary, equally narrow contract that governs **what
the server is allowed to become** as harness features expand. As of the 1.11
cleanup cycle, the open PR queue contains five candidate harness families (trace,
skill state graph, outcome contracts, perception primitives, skill memory) whose
unconstrained adoption would compromise two existing OpenChrome value propositions:

1. **Backward compatibility.** Existing 1.10.4 MCP clients depend on the current
   tool surface behaving exactly as documented. Harness features that mutate that
   surface — by default — break those clients silently.
2. **MCP portability.** OpenChrome's distribution model is `npx openchrome-mcp` and
   the Tauri desktop app. Both rely on the server starting on any modern Linux,
   macOS, or Windows host without external secrets, manual setup, or platform-specific
   compile toolchains. Features that quietly require API keys, network egress to
   third-party LLM providers, or native modules without a fallback degrade that
   "anywhere-compatible" property.

This contract is the design constraint that lets harness work proceed without
eroding either property.

---

## Philosophy

> **OpenChrome is a tool server.** Harness features reinforce the tool-call
> guarantee and the data captured around it. They never trade portability or
> existing-client compatibility for harness richness.

The contract is narrow and precise by design. It does not dictate which harness
features are valuable. It dictates the conditions under which a harness feature
may ship inside the `openchrome-mcp` package.

---

## Scope

Applies to every PR that:

- adds or modifies a tool, resource, or transport on the MCP surface;
- introduces a new module under `src/` that is reachable from tool dispatch,
  recorder, or executor paths;
- adds, removes, or pins a runtime dependency in `package.json`;
- modifies `src/index.ts`, `src/mcp-server.ts`, `cli/`, or any startup wiring.

Does **not** apply to: documentation-only PRs, CI infrastructure PRs, test-only
PRs that touch no production code.

---

## Principles

### P1. Tool server identity

OpenChrome accepts tool calls, executes them, and returns results. It does not
orchestrate multi-step tasks, manage AI agent lifecycles, or operate as a
continuous autonomous loop. Long-lived background work inside the server is
permitted only when it serves a tool-call guarantee (e.g., Chrome process
supervision, CDP reconnection).

This principle re-states the responsibility boundary from
`issue-reliability-guarantee.md` and is reproduced here so that
portability-relevant PRs are evaluated against it without a cross-reference.

### P2. Zero-impact harness extension

A harness feature may add capability, but it must not change the observable
behavior of any tool, resource, transport, or startup sequence that existed in
1.10.4 when the feature is off. "Off" includes:

- the feature's environment flag is unset or `0`;
- the feature's optional native dependency failed to load;
- the feature's storage directory is missing or unwritable.

In each "off" condition, the server boots, every 1.10.4 tool call executes, and
`tools/list` / `resources/list` return the 1.10.4 surface exactly.

### P3. Anywhere-compatible MCP

`npx openchrome-mcp setup` and the Tauri desktop installer must succeed on:

- Linux x86_64 (glibc and musl) and aarch64;
- macOS x86_64 and arm64;
- Windows x86_64.

A harness feature may not require:

- an outbound HTTP call to any third-party LLM API (Anthropic, OpenAI, Google,
  or comparable) inside the server process;
- a mandatory API key, OAuth token, or vendor credential at boot;
- a platform-specific build toolchain at install time;
- access to OS keychain, Secret Service, or Credential Manager;
- a network-attached secret store.

Features that are useful only with such resources must remain disabled until the
operator opts in; their disabled state must satisfy P2.

### P4. Facts versus decisions

OpenChrome captures, computes, stores, retrieves, normalizes, and verifies
facts about browser sessions. It does not make LLM-driven decisions. The host
agent that connects to OpenChrome may make any decision it wants using the
facts the server exposes; the server itself does not call out to language
models or other "judgment" services to interpret captured data.

Operationally: a PR that adds a tool returning a perceptual hash, a screenshot
class, a verdict from a deterministic contract runner, or a stored skill record
is a *fact* PR and is in scope for this server. A PR that adds a tool calling
Anthropic to vote on the meaning of those facts is a *decision* PR and belongs
in a host-side library or a separate package.

### P5. Native dependency discipline

The main `openchrome-mcp` package may declare at most one mandatory native
runtime dependency: `argon2` (required by authentication). Every other native
dependency must satisfy all of the following:

- declared in `optionalDependencies`, not `dependencies`;
- consumed via a lazy `require` guarded by a try/catch fallback that produces a
  Noop or pure-JS implementation;
- documented in `docs/roadmap/native-deps.md` (created when the second native
  dependency is proposed) with the fallback path and the failure surface.

`better-sqlite3` is not adopted. Storage layers that previously assumed it use
JSONL or JSON files plus `proper-lockfile` for concurrent-write coordination.

---

## Per-feature activation flags

Optional harness families are gated by per-family environment variables. Each
defaults to off and Noops independently:

| Family             | Flag                          | Default |
|--------------------|-------------------------------|---------|
| Trace recorder     | `OPENCHROME_TRACE`            | off     |
| Skill state graph  | `OPENCHROME_STATE_GRAPH`      | off     |
| Perception         | `OPENCHROME_PERCEPTION`       | off     |
| Skill memory       | `OPENCHROME_SKILL_MEMORY`     | off     |

The presence of any flag must not change the behavior of unrelated features.
Outcome Contracts (the necessary family) ships unflagged because its existence
strengthens the reliability contract and adds no surface that could be off.

A combined flag (e.g., `OPENCHROME_HARNESS=1`) is explicitly not provided. The
per-family separation is part of the contract; a future PR proposing a
combined flag must amend this document first.

---

## Handoff token encryption (#755 family)

The handoff token persistence layer encrypts tokens with AES-256-GCM. The
encryption key is ephemeral by default — it lives in process memory and is
regenerated on every server start, which invalidates any persisted handoff
tokens from prior runs. Operators wanting cross-restart persistence set
`OPENCHROME_HANDOFF_KEY_FILE=<path>`; the file contains a 32-byte key,
loaded at boot, never logged, never embedded in audit records.

No OS keychain integration is provided (P3 prohibits it).

---

## PR review checklist

Every PR matching the scope above must demonstrate the following in its body
or in the diff:

- [ ] **Facts, not decisions.** The PR adds capability that is descriptive,
      computational, or storage-oriented. It does not call an LLM API from the
      server. If the PR adds a `Voter` or similar interface, at least one
      deterministic implementation accompanies it.
- [ ] **Off behavior.** When the relevant feature flag is unset, every code
      path added by this PR is unreachable from tool dispatch, recorder, and
      executor. A test or trace demonstrates this.
- [ ] **No new mandatory native dependency.** `package.json` changes do not
      add anything to `dependencies` beyond `argon2`. New native modules, if
      any, are in `optionalDependencies` with a documented fallback.
- [ ] **No mandatory API key, network egress, or vendor credential.** Boot
      succeeds with all third-party LLM provider variables unset.
- [ ] **1.10.4 surface preserved.** `tools/list` and `resources/list` return
      the 1.10.4 set when all feature flags are unset.
- [ ] **Reliability contract not regressed.** Tool-call timeout behavior is
      unchanged. Any new path that could block the event loop has an explicit
      bound.

PRs failing any item must be modified before merge. PRs that cannot satisfy
P4 (facts vs decisions) are out of scope and should be moved to a separate
package or host-side library; close-with-redirect is the expected outcome.

---

## Non-goals

- This contract does not impose a feature roadmap. It does not require any
  optional family to ship; it only specifies the conditions under which they
  may.
- It does not promise zero-config across all features. With every flag unset
  the server is zero-config; enabling a family is the operator's act.
- It does not duplicate the reliability contract. Where they overlap (e.g.,
  P1, the no-event-loop-block checklist item) the reliability contract is the
  authoritative source.

---

## Document status

Normative. Every PR landing on `develop` after this document merges must satisfy
the checklist. Application to the 35 currently-open PRs is tracked in
`openchrome-1.11-cleanup.md`.
