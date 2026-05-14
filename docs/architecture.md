# OpenChrome Architecture

This document gives a one-page overview of how OpenChrome is structured at the
v1.11 line. For the rationale behind the structure, read
[`docs/roadmap/portability-harness-contract.md`](roadmap/portability-harness-contract.md).
For end-to-end usage, see [`docs/getting-started.md`](getting-started.md).

## One-line summary

> OpenChrome is an MCP server that exposes Chrome via the Chrome DevTools
> Protocol. It captures facts (DOM, screenshots, network, traces, skills,
> contracts); a host agent uses those facts to decide what to do next.

## Two tiers

```
openchrome-mcp (one npm package, one binary, one CLI)
│
├── src/core/           ← active by default, no flag
│   │                     P1–P5 strictly enforced
│   │
│   ├── trace/          JSONL session capture + credential redactor
│   ├── skill/          JSON-per-domain state graph + URL normalizer
│   ├── skill-memory/   JSON-per-domain skill store + audit-log stats
│   ├── contracts/      Outcome contract DSL + 7 evaluators + pHash
│   ├── perception/     Perceptual DOM metadata + Sobel/color cross-check
│   ├── cli/            Replay UI and inspection commands
│   ├── mcp/            Server, transports, tool dispatch
│   └── resources/      openchrome://skill-graph/<domain>
│
└── src/pilot/          ← opt-in via --pilot
                          Relaxes P1 (background work) and P4 (policy);
                          still enforces P3 (no LLM API calls).
    │
    ├── runtime/        Contract runtime: retry, verdict taxonomy,
    │                   idempotency cache, beforeIrreversibleAction hook
    ├── handoff/        Token + manager + AES-256-GCM persistence
    │                   (ephemeral key default)
    ├── voting/         Voter interface + orchestrator (deterministic;
    │                   LLM-backed voters live in host-side libraries)
    └── curator/        Verified skill extractor + recall ranking +
                        Pass 1 prune + Pass 2 structural merge +
                        Pass 3 promote + PID lock + background runner
```

### Import boundary

The directory split is enforced by a `dependency-cruiser` rule
(`.dependency-cruiser.cjs`):

- `src/core/**` **must not** import from `src/pilot/**`.
- `src/pilot/**` **may** import from `src/core/**`.

CI fails on any PR that violates the rule (`npm run lint:tier`).

### Shared helper module

`src/harness/flags.ts` lives at neither tier; both can import it. It exposes:

- `isPilotEnabled()` — true iff `--pilot` argv flag or `OPENCHROME_PILOT` env
  is set
- `isTraceEnabled()`, `isStateGraphEnabled()`, `isContractRuntimeEnabled()`,
  `isHandoffPersistEnabled()`, `isPerceptionVotingEnabled()`,
  `isSkillCuratorEnabled()` — per-family getters
- `bootstrapPilot()` — dynamic `import('../pilot/index.js')`, returns null
  when `--pilot` is unset (proof that no pilot module enters the process)
- `logActiveFlags()` — single `[harness] core only` or
  `[harness] core+pilot enabled (...)` line to **stderr** at startup

## The five principles

The contract that governs every PR landing on `develop`:

- **P1. Tool server identity** — accept tool calls, return results. Long-lived
  background work only in pilot, only when an operator enables it.
- **P2. Zero-impact harness extension** — when `--pilot` is unset, every
  optional native dep fails to load gracefully, every storage directory may
  be missing, and the 1.10.4 tool surface still returns bit-identical
  responses.
- **P3. Anywhere-compatible MCP** — no outbound LLM API calls, no mandatory
  API keys at boot, no platform-specific compile toolchains, no OS keychains.
  Applies to **both tiers**.
- **P4. Facts versus decisions** — the server stores and computes facts.
  LLM judgment lives outside the server (host agent or separate package).
- **P5. Native dependency discipline** — `argon2` is the only mandatory
  native runtime dep. Future native deps go into `optionalDependencies`
  with a documented fallback.

## Transport surfaces

OpenChrome supports `stdio`, `http`, and `both` transport modes over the same deterministic MCP tool server. Use [`docs/getting-started/http-daemon.md`](getting-started/http-daemon.md) for the operator-focused HTTP daemon walkthrough, including multi-client topology, auth, `/health`, `/metrics`, and idle-timeout behavior. Use [`docs/transport-lifecycle.md`](transport-lifecycle.md) for stability commitments and deprecation policy.

## Data flow for a typical agent loop

```
                 ┌──────────────────────────────────────────────────────────┐
                 │                  HOST AGENT (Claude Code, etc.)          │
                 │                                                          │
                 │   1. Reads tools/list                                    │
                 │   2. Decides which tool to call                          │
                 │   3. Calls oc_assert / oc_skill_recall / navigate / ...  │
                 │   4. Receives facts; runs its own model to decide next   │
                 └──────────────────────────────────────────────────────────┘
                                              │
                                  JSON-RPC over stdio (or HTTP)
                                              ▼
                 ┌──────────────────────────────────────────────────────────┐
                 │                    openchrome-mcp                        │
                 │                                                          │
                 │   ┌─────────┐    ┌────────────────────┐                  │
                 │   │ core/   │ ←─ │ mcp dispatcher     │                  │
                 │   │ tools   │    │ + tier-1 gating    │                  │
                 │   └────┬────┘    └──────┬─────────────┘                  │
                 │        │                │                                │
                 │        │   --pilot? ─── ▼                                │
                 │        │           ┌─────────┐                           │
                 │        │           │ pilot/  │                           │
                 │        │           └────┬────┘                           │
                 │        │                │                                │
                 │   ┌────▼────────────────▼──────┐                         │
                 │   │   CDP client + Chrome      │                         │
                 │   │   process supervision      │                         │
                 │   └────────────┬───────────────┘                         │
                 └────────────────┼─────────────────────────────────────────┘
                                  │
                              CDP / DevTools Protocol
                                  ▼
                          ┌──────────────────┐
                          │   real Chrome    │
                          │  (your profile)  │
                          └──────────────────┘
```

### Where the LLM lives

> The LLM is in the **host agent**, not in `openchrome-mcp`. The server
> never calls Anthropic / OpenAI / Google directly. If you want LLM-powered
> voting or merge, the host agent calls its own model and then calls the
> appropriate openchrome-mcp tool to record the result.

## Storage policy

Everything new in v1.11 stores to JSONL or JSON files coordinated by
[`proper-lockfile`](https://www.npmjs.com/package/proper-lockfile). No
SQLite. Concrete paths:

```
~/.openchrome/
├── trace/<sessionId>/<ts>-<seq>.jsonl       trace events
├── trace/<sessionId>/meta.json              session metadata
├── skill-graph/<encodedDomain>.json         JSON-per-domain skill graph
├── skill-memory/<encodedDomain>/skills.json skill records
├── skill-memory/<encodedDomain>/snapshots/  gzipped frozen snapshots
├── audit.log                                JSONL audit log
└── handoff/<sha256(token)>.enc              AES-256-GCM encrypted token
                                             (ephemeral key, lost on restart
                                             unless OPENCHROME_HANDOFF_KEY_FILE)
```

`src/utils/atomic-file.ts` provides `writeFileAtomicSafe`,
`readFileSafe`, and `acquireLock` helpers that every new storage layer
uses.

## Dependency footprint

Mandatory native runtime dep: **`argon2`** (authentication). Pure-JS deps:
`commander`, `jose`, `proper-lockfile`, `puppeteer-core`
(`rebrowser-puppeteer-core` re-namespaced), `uuid`, `write-file-atomic`.
Top-level `npm overrides` for `basic-ftp` and `ip-address` neutralize
transitive advisories.


## Composition patterns

OpenChrome keeps multi-step research composition in host-controlled recipes rather than adding server-side LLM planning. Runnable examples live in [`docs/recipes/`](recipes/README.md), including the topic survey, single-page deep extract, and changelog watch patterns from issue #858. These recipes combine existing deterministic tools such as `read_page`, `extract_data`, `validate_page`, `oc_assert`, `oc_evidence_bundle`, and `batch_execute` without changing the MCP API surface.

## Out of scope for the server

Things that explicitly do **not** live in `openchrome-mcp`:

- Server-side LLM API calls (Anthropic / OpenAI / Google etc.) — see P3
- Multi-step task orchestration — host agent's job
- AI agent lifecycle management — host process's job
- 24/7 uptime SLA — operator infrastructure
- OS keychain / Secret Service / Credential Manager integration —
  use `OPENCHROME_HANDOFF_KEY_FILE` instead

## Reference

- Contract: [`docs/roadmap/portability-harness-contract.md`](roadmap/portability-harness-contract.md)
- Reliability contract: [`docs/roadmap/issue-reliability-guarantee.md`](roadmap/issue-reliability-guarantee.md)
- v1.11 cleanup history: [`docs/roadmap/history/openchrome-1.11-cleanup.md`](roadmap/history/openchrome-1.11-cleanup.md)
- v1.11.1 release notes: [`docs/releases/v1.11.1.md`](releases/v1.11.1.md)
