# OpenChrome 1.11 Cleanup — Open PR Disposition

One-time application of `portability-harness-contract.md` to the 35 PRs that
were open at the start of the 1.11 cleanup cycle. This document is not
normative; once every action listed here is taken, this document becomes a
historical record.

The contract takes precedence over any disposition below. If a discrepancy is
discovered between this plan and the contract, the contract wins and this
document is amended.

---

## Family classification recap

| Family             | Verdict       | Reason                                                                                          |
|--------------------|---------------|-------------------------------------------------------------------------------------------------|
| Outcome Contracts  | Necessary     | Directly reinforces "tool call returns within timeout" via verdicts, idempotency, irrev. hook   |
| Trace recorder     | Optional      | Useful for replay and audit; not required for the contract; gated by `OPENCHROME_TRACE`         |
| Skill state graph  | Optional      | Cross-session learning data layer; gated by `OPENCHROME_STATE_GRAPH`; executor must Noop when off |
| Perception (prim.) | Optional      | Pure-compute primitives; gated by `OPENCHROME_PERCEPTION`                                       |
| Skill memory       | Optional      | Recall data layer; gated by `OPENCHROME_SKILL_MEMORY`                                           |
| In-server LLM      | Out of scope  | Violates P3 and P4; belongs in host-side library or separate package                            |

`better-sqlite3` is not adopted. All storage layers in the optional families
must use JSONL or JSON plus `proper-lockfile`.

---

## Action codes

- **merge-now** — already complies with the contract; merge after standard CI.
- **merge-after-gate** — code is sound; add the per-family environment flag
  and a Noop branch when off, then merge.
- **close-rewrite** — storage layer assumes `better-sqlite3`; close the PR,
  reopen a replacement that uses JSONL/JSON + `proper-lockfile`.
- **close-rebase** — depends on a `close-rewrite` ancestor; close, then reopen
  rebased onto the new ancestor with the appropriate feature gate.
- **close-move** — out of scope (P3 / P4 violation); close with a redirect
  comment, code moves to a separate package or host-side library.
- **modify-body** — code is fine; only the PR description needs adjustment
  before merge.

---

## Per-PR disposition

### Standalone fixes (target: develop, no stack)

| PR    | Title                                                              | Action     | Notes                                       |
|-------|--------------------------------------------------------------------|------------|---------------------------------------------|
| #773  | fix: improve javascript_tool diagnostics and shadow DOM helpers    | merge-now  | Reliability/security aligned; no contract concern |
| #771  | Fix auto-launched Chrome window bounds placement                   | merge-now  | Cross-platform CI green                     |
| #767  | test: opt-in to allowUnauthenticatedHttp in HTTP transport tests   | merge-now  | Uses documented escape hatch                |
| #742  | fix(deps): bump basic-ftp and ip-address via npm overrides         | merge-now  | Security advisories closed, no source changes |

### M1 trace recorder (#735, #736, #743–#747)

| PR    | Title                                                                                  | Action          | Notes |
|-------|----------------------------------------------------------------------------------------|-----------------|-------|
| #735  | feat(trace): SQLite storage backend + credential redactor (M1 PR-1)                    | close-rewrite   | Storage layer must be JSONL-only. `better-sqlite3` removed from `package.json`. Index for `oc trace list` becomes filesystem scan or JSON sidecar |
| #736  | feat(trace): session recorder with CDP event subscription (M1 PR-2)                    | close-rebase    | Rebased onto new JSONL trace storage |
| #743  | feat(cli): oc trace list/show + oc skill list/inspect                                  | close-rebase    | Rebased; list path adjusted to JSONL scan |
| #744  | feat(trace): wire recorder into CDPClient.createPage()                                 | close-rebase    | Gate behind `OPENCHROME_TRACE`; Noop when off |
| #745  | feat(cli): oc trace play replay UI                                                     | close-rebase    | No storage code change; rebase for base ref |
| #746  | feat(mcp): expose openchrome://trace/* resources to LLM clients                        | close-rebase    | Resources registered only when `OPENCHROME_TRACE` is set |
| #747  | feat(trace): wire recorder into createTargetStealth() too                              | close-rebase    | Gate behind `OPENCHROME_TRACE`; Noop when off |

### M1 skill state graph (#737–#741)

| PR    | Title                                                                                  | Action            | Notes |
|-------|----------------------------------------------------------------------------------------|-------------------|-------|
| #737  | feat(skill): state hashing + URL normalizer + interactive filter                       | merge-after-gate  | Pure logic; no storage. Gate consumers behind `OPENCHROME_STATE_GRAPH` when wired |
| #738  | feat(skill): per-domain skill graph SQLite storage (M1 PR-5)                           | close-rewrite     | Rewrite as JSON-per-domain + `proper-lockfile`. Same `to_state_distribution` schema, file-based. Per-domain lock matches the original concurrency model |
| #739  | feat(skill): graph-aware executor with resume-from-state                               | close-rebase      | Rebased onto new JSON graph. Executor branch must be unreachable when `OPENCHROME_STATE_GRAPH` unset |
| #740  | docs(skill-graph): DOM snapshot capture procedure for fixtures                         | modify-body       | Update docs to reflect JSON storage; merge |
| #741  | feat(skill): graph audit telemetry + executor integration                              | close-rebase      | Rebased; Noop when feature off |

### M2 outcome contracts (#748–#756)

All necessary. Standard review applies. The contract document does not require
gating these.

| PR    | Title                                                                                  | Action     | Notes |
|-------|----------------------------------------------------------------------------------------|------------|-------|
| #748  | feat(contracts): DSL types + assertions + validator (M2 PR-9)                          | merge-now  | |
| #749  | feat(contracts): runtime core with verdict taxonomy + retry (M2 PR-11)                 | merge-now  | |
| #750  | feat(contracts): idempotency cache + preemptive cancellation (M2 PR-12)                | merge-now  | |
| #751  | feat(contracts): evidence bundle generator + MCP resource (M2 PR-13)                   | merge-now  | |
| #752  | feat(#705): contract DSL and assertion primitives                                      | merge-now  | Resolve phash.ts divergence with #753 before merge |
| #753  | feat(contracts): pHash + screenshot class registry + screenshot_class assertion        | merge-now  | After #752 lands, rebase and reconcile phash.ts |
| #754  | feat(contracts): handoff token + banner + manager (happy path)                         | merge-now  | In-memory tokens; persistence is #755 |
| #755  | feat(contracts): handoff persistence with AES-256-GCM                                  | merge-after-gate | Key management policy: ephemeral default; `OPENCHROME_HANDOFF_KEY_FILE=<path>` opts into file-backed persistence. Document in PR body before merge |
| #756  | feat(contracts): beforeIrreversibleAction hook for critical contracts                  | merge-now  | Hook fires only when a contract is declared `critical: true`; default path unchanged |

### M3 perception (#757–#760)

| PR    | Title                                                                                  | Action            | Notes |
|-------|----------------------------------------------------------------------------------------|-------------------|-------|
| #757  | feat(perception): perceptual DOM metadata + cache                                      | merge-after-gate  | Pure compute; gate behind `OPENCHROME_PERCEPTION` |
| #758  | feat(perception): cross-check core — Sobel + color distance                            | merge-after-gate  | Pure compute; gate behind `OPENCHROME_PERCEPTION` |
| #759  | feat(perception): multi-model voting + args equivalence (M3 PR-19)                     | modify-body       | Voter interface is neutral. PR body must reframe "two configured perception models" to "two configured voters (deterministic or LLM)" and add at least one deterministic voter test before merge |
| #760  | feat(perception): voting provider HTTP wrappers (anthropic + openai)                   | close-move        | Violates P3 (mandatory third-party API egress) and P4 (decision in server). Move to `openchrome-perception-voters` (separate npm package) or host-side library. Close PR with redirect comment |

### M4 skill memory (#761–#766)

| PR    | Title                                                                                  | Action            | Notes |
|-------|----------------------------------------------------------------------------------------|-------------------|-------|
| #761  | feat(skill-memory): verified skill extractor (M4 PR-20)                                | merge-after-gate  | Deterministic transform; gate behind `OPENCHROME_SKILL_MEMORY` |
| #762  | feat(skill-memory): skill recall + frozen-snapshot store (M4 PR-21)                    | close-rewrite     | Rewrite as JSON-per-domain `skills.json` + `proper-lockfile`. Frozen snapshots remain `.json.gz` on disk |
| #763  | feat(skill-memory): curator (Pass 1 + Pass 3) + PID lock (M4 PR-22)                    | close-rebase      | Rebased onto new JSON store; PID lock retained |
| #764  | feat(skill-memory): curator Pass 2 — sibling skill merge (M4 PR-23)                    | close-rebase      | Structural-only heuristic; no LLM. Rebased onto new store |
| #765  | feat(skill-memory): LLM merge requester for curator Pass 2                             | close-move        | Violates P3 and P4. Move to host-side library or `openchrome-skill-curator-llm` package. Close PR with redirect comment |
| #766  | feat(skill-memory): audit-log-backed SkillStatsResolver for the curator                | close-rebase      | Audit log path unchanged; only the consuming store is rebased |

---

## Sequencing

The cleanup proceeds in phases. Each phase's completion is the gate for the
next; this is to prevent partial states where some PRs see one storage layer
and other PRs see another.

### Phase 0 — Contract publication

Land `portability-harness-contract.md` and this cleanup plan on `develop` so
every subsequent PR references them.

### Phase 1 — Standalone fixes

Merge #773, #771, #767, #742. No dependency on contract; mergeable in parallel.

### Phase 2 — Outcome Contracts (necessary family)

Merge #748 → #749 → #750 → #751 → #752 → #753 (phash.ts reconciled) → #754
→ #755 (with handoff key policy documented in PR body) → #756.

This phase delivers the necessary family. Existing 1.10.4 behavior is
preserved because the new tools live behind their existing contract DSL
declarations; calls that do not declare a contract are unaffected.

### Phase 3 — Storage rewrites (close + reopen)

Close #735, #738, #762. Open three replacement PRs:

- new trace storage (JSONL-only, no SQLite, no index DB)
- new skill graph storage (JSON per domain + `proper-lockfile`)
- new skill memory recall store (JSON per domain + `proper-lockfile`)

Each replacement PR carries the relevant `OPENCHROME_*` flag gate from the
contract. The replacement PRs are smaller than the originals because they ship
no migrations and no SQLite-specific code paths.

### Phase 4 — Stack rebases (close + reopen)

Close and reopen the upper-stack PRs against the new bases:

- M1 trace upper stack: #736, #743, #744, #745, #746, #747
- M1 skill graph upper stack: #739, #741 (plus #740 as modify-body)
- M4 skill memory upper stack: #763, #764, #766
- #737 (state hashing) is merge-after-gate independently; can land in either
  phase.

Each reopened PR adds the relevant feature gate; off-by-default behavior must
match 1.10.4 exactly. Phase 4 PRs do not need to be merged in lockstep with
each other, only with the corresponding Phase 3 base.

### Phase 5 — Perception and Skill Memory entrypoints

Merge #757, #758, #761 (each `merge-after-gate`). Merge #759 after the body
reframing.

### Phase 6 — Out-of-scope close-and-move

Close #760 and #765 with redirect comments. Open issues tracking the host-side
or separate-package replacements; link from this document once those exist.

---

## Acceptance

This cleanup is complete when:

- every row in the per-PR table has reached its terminal state (merged, closed,
  or replaced);
- `develop` builds, lints, and the full test suite passes;
- `tools/list` and `resources/list` against the resulting build, with every
  `OPENCHROME_*` flag unset, return the 1.10.4 tool surface byte-for-byte
  (modulo the contract-related additions from Phase 2 that operate without a
  flag);
- the contract checklist in `portability-harness-contract.md` is verifiably
  satisfied by every PR that landed during the cleanup.

After completion, this document is moved to `docs/roadmap/history/` and
referenced from a release note. The contract document remains.
