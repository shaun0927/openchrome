# OpenChrome 1.11 Cleanup — Open PR Disposition

One-time application of `portability-harness-contract.md` to the 35 PRs that
were open at the start of the 1.11 cleanup cycle. This document is not
normative; once every action listed here is taken, it becomes a historical
record and moves to `docs/roadmap/history/`.

The contract takes precedence over any disposition below. If a discrepancy is
discovered between this plan and the contract, the contract wins and this
document is amended.

The plan applies the **hybrid resolution** of PR #774 and issue #768: the
`core` / `pilot` tier mechanism from #768, with the stricter content of PR #774
(better-sqlite3 not adopted; in-server LLM features go to separate packages, not
to `src/pilot/`).

---

## Family classification recap

| Family             | Tier               | Action shape                                                         |
|--------------------|--------------------|----------------------------------------------------------------------|
| Outcome Contracts  | core (DSL, oc_assert, oc_evidence_bundle, pHash, screenshot class) + pilot (runtime, retry, idempotency, handoff, beforeIrreversibleAction) | merge with directory move; some reroute to pilot |
| Trace recorder     | core               | merge with directory move; SQLite storage rewritten as JSONL         |
| Skill state graph  | core (storage, hashing, CLI, MCP resource) + pilot (graph executor with resume-from-state) | merge with directory move + storage rewrite; executor reroute to pilot |
| Perception         | core (primitives) + pilot (voting framework, deterministic voters only) | merge with directory move; LLM voter wrappers go to separate package |
| Skill memory       | core (store + audit-log stats) + pilot (curator, extractor, recall ranking) | merge with directory move + storage rewrite; LLM merge requester to separate package |
| In-server LLM      | **out of scope**   | close with redirect to separate-package extraction issues             |

`better-sqlite3` is not adopted. All storage layers in both tiers use JSONL or
JSON plus the existing `src/utils/atomic-file.ts` + `proper-lockfile`.

---

## Action codes

- **MERGE → core/X** — retarget to `develop`, move files into `src/core/X/`,
  merge after CI. Code is preserved as written.
- **MERGE → docs/core/X** — same but for documentation PRs.
- **REROUTE → pilot/X** — retarget to `develop`, move files into `src/pilot/X/`,
  open as new PR with `tier:pilot` label, close original with pointer.
- **MERGE-RECONCILE → core/X** — same as MERGE but requires file-conflict
  resolution (notably `src/contracts/phash.ts` between #752 and #753).
- **SPLIT** — one PR becomes two: a core slice and a pilot slice.
- **CLOSE-REWRITE** — close the PR; reopen replacement that drops
  `better-sqlite3` for JSONL/JSON + `proper-lockfile`.
- **CLOSE-MOVE** — close the PR with a redirect; code moves to a separate npm
  package or host-side library (tracked in #775 / #776).
- **MERGE-NOW** — standalone fix, already compliant; merge after standard CI.

For every REROUTE the procedure is:

1. `git cherry-pick` each commit from the original PR onto a new branch based
   on `develop`.
2. `git mv` the affected files into `src/pilot/<subdir>/`.
3. Open a new PR titled `feat(pilot): <original title> [relocated from #N]`.
4. Close the original PR with: *"Code preserved in #NEW; relocated under
   `src/pilot/` per the hybrid plan in `openchrome-1.11-cleanup.md` and
   PR #774."*

---

## Per-PR disposition

### Standalone fixes (target: develop, no stack)

| PR    | Title                                                              | Action     | Notes |
|-------|--------------------------------------------------------------------|------------|-------|
| #773  | fix: improve javascript_tool diagnostics and shadow DOM helpers    | MERGE-NOW  | Currently base=`main`. Retarget to `develop` first (`gh pr edit 773 --base develop`) |
| #771  | Fix auto-launched Chrome window bounds placement                   | MERGE-NOW  | Cross-platform CI green |
| #767  | test: opt-in to allowUnauthenticatedHttp in HTTP transport tests   | MERGE-NOW  | **Merge first** — fixes 4 inherited HTTP-auth test failures on develop |
| #742  | fix(deps): bump basic-ftp and ip-address via npm overrides         | MERGE-NOW  | Security advisories closed, no source changes |

### M1 trace recorder (#735, #736, #743–#747)

| PR    | Title                                                                                  | Action                              |
|-------|----------------------------------------------------------------------------------------|-------------------------------------|
| #735  | feat(trace): SQLite storage backend + credential redactor (M1 PR-1)                    | **CLOSE-REWRITE** → `src/core/trace/` with JSONL storage |
| #736  | feat(trace): session recorder with CDP event subscription (M1 PR-2)                    | MERGE → `src/core/trace/` (after #735 rewrite lands) |
| #743  | feat(cli): oc trace list/show + oc skill list/inspect                                  | MERGE → `src/core/cli/` (list path uses filesystem scan, not SQLite query) |
| #744  | feat(trace): wire recorder into CDPClient.createPage()                                 | MERGE → `src/core/trace/` |
| #745  | feat(cli): oc trace play replay UI                                                     | MERGE → `src/core/cli/` |
| #746  | feat(mcp): expose openchrome://trace/* resources to LLM clients                        | MERGE → `src/core/mcp/resources/` |
| #747  | feat(trace): wire recorder into createTargetStealth() too                              | MERGE → `src/core/trace/` |

### M1 skill state graph (#737–#741)

| PR    | Title                                                                                  | Action                              |
|-------|----------------------------------------------------------------------------------------|-------------------------------------|
| #737  | feat(skill): state hashing + URL normalizer + interactive filter                       | MERGE → `src/core/skill/` |
| #738  | feat(skill): per-domain skill graph SQLite storage (M1 PR-5)                           | **CLOSE-REWRITE** → `src/core/skill/` as JSON-per-domain + `proper-lockfile`. Read-only API exposed under `openchrome://skill-graph/<domain>` |
| #739  | feat(skill): graph-aware executor with resume-from-state                               | **REROUTE → `src/pilot/executor/`** |
| #740  | docs(skill-graph): DOM snapshot capture procedure for fixtures                         | MERGE → `docs/core/skill/` after rewriting to reference JSON storage |
| #741  | feat(skill): graph audit telemetry + executor integration                              | **SPLIT** — telemetry to `src/core/skill/`, executor wiring to `src/pilot/executor/` |

### M2 outcome contracts (#748–#756)

All currently stacked on top of the M1 chain. Each needs to be cherry-picked
onto develop as a new PR before any tier action can be taken.

| PR    | Title                                                                                  | Action                              |
|-------|----------------------------------------------------------------------------------------|-------------------------------------|
| #748  | feat(contracts): DSL types + assertions + validator (M2 PR-9)                          | MERGE → `src/core/contracts/`. Schema accepts `on_fail` / `budget` fields but core ignores them; pilot runtime interprets |
| #749  | feat(contracts): runtime core with verdict taxonomy + retry (M2 PR-11)                 | **REROUTE → `src/pilot/runtime/`** |
| #750  | feat(contracts): idempotency cache + preemptive cancellation (M2 PR-12)                | **REROUTE → `src/pilot/runtime/`** |
| #751  | feat(contracts): evidence bundle generator + MCP resource (M2 PR-13)                   | MERGE → `src/core/contracts/`, exposed as MCP tool `oc_evidence_bundle`, decoupled from failure verdict (so it works in core without the pilot runtime) |
| #752  | feat(#705): contract DSL and assertion primitives                                      | MERGE-RECONCILE → `src/core/contracts/`. Merge first (already on `develop`); keep its DCT-II `phash.ts` |
| #753  | feat(contracts): pHash + screenshot class registry + screenshot_class assertion (M2 PR-10) | MERGE-RECONCILE → `src/core/contracts/` after `phash.ts` reconciled with #752 |
| #754  | feat(contracts): handoff token + banner + manager (M2 PR-14 happy path)                | **REROUTE → `src/pilot/handoff/`** |
| #755  | feat(contracts): handoff persistence with AES-256-GCM (M2 PR-15 partial)               | **REROUTE → `src/pilot/handoff/`**. Ephemeral key by default; `OPENCHROME_HANDOFF_KEY_FILE=<path>` opts into file-backed persistence. Document in PR body. No OS keychain (P3) |
| #756  | feat(contracts): beforeIrreversibleAction hook for critical contracts                  | **REROUTE → `src/pilot/runtime/`** |

### M3 perception (#757–#760)

| PR    | Title                                                                                  | Action                              |
|-------|----------------------------------------------------------------------------------------|-------------------------------------|
| #757  | feat(perception): perceptual DOM metadata + cache                                      | MERGE → `src/core/perception/` |
| #758  | feat(perception): cross-check core — Sobel + color distance                            | MERGE → `src/core/perception/` |
| #759  | feat(perception): multi-model voting + args equivalence                                | **REROUTE → `src/pilot/voting/`**. PR body must reframe "two configured perception models" to "two configured voters (deterministic or LLM)" and ship at least one deterministic voter test. **No Anthropic/OpenAI providers ship with this PR.** |
| #760  | feat(perception): voting provider HTTP wrappers (anthropic + openai)                   | **CLOSE-MOVE** → tracked by #775 (separate `openchrome-perception-voters` package). Violates P3 (mandatory third-party API egress) — would be rejected even in pilot |

### M4 skill memory (#761–#766)

| PR    | Title                                                                                  | Action                              |
|-------|----------------------------------------------------------------------------------------|-------------------------------------|
| #761  | feat(skill-memory): verified skill extractor (M4 PR-20)                                | **REROUTE → `src/pilot/curator/`**. Deterministic transform, but lives in pilot because the extractor only runs when a curator is active |
| #762  | feat(skill-memory): skill recall + frozen-snapshot store (M4 PR-21)                    | **CLOSE-REWRITE + SPLIT**. Replacement opens two PRs: store → `src/core/skill-memory/` (JSON-per-domain + `proper-lockfile`); recall ranking → `src/pilot/curator/recall.ts` |
| #763  | feat(skill-memory): curator (Pass 1 + Pass 3) + PID lock (M4 PR-22)                    | **REROUTE → `src/pilot/curator/`** after rebase onto JSON store |
| #764  | feat(skill-memory): curator Pass 2 — sibling skill merge (M4 PR-23)                    | **REROUTE → `src/pilot/curator/`**. Structural-only heuristic; no LLM |
| #765  | feat(skill-memory): LLM merge requester for curator Pass 2                             | **CLOSE-MOVE** → tracked by #776 (separate `openchrome-skill-curator-llm` package). Violates P3 — would be rejected even in pilot |
| #766  | feat(skill-memory): audit-log-backed SkillStatsResolver for the curator                | MERGE → `src/core/skill-memory/` (read-only over audit log; serves both core consumers and the pilot curator) |

---

## New tools that ship with v1.11.0 core

The core tier adds four new MCP tools beyond the 1.10.4 surface. These are
unflagged (active without `--pilot`) because they are read-only or verification
primitives that satisfy P1–P5 strictly.

| Tool / Resource                          | Source            | Tracking issue |
|------------------------------------------|-------------------|----------------|
| `oc_assert`                              | new               | TBD (file alongside Phase 0 amendment) |
| `oc_evidence_bundle`                     | generalizes #751  | TBD            |
| `oc_skill_record`                        | new               | TBD            |
| `oc_skill_recall` (read-only over store) | new               | TBD            |
| `openchrome://skill-graph/<domain>` (MCP resource, read-only) | new | TBD |

These four are filed as a single bootstrap batch alongside the dependency-cruiser
lint rule, two-stage CI workflow, `--pilot` flag scaffolding, and v1.11 release
plan.

---

## Sequencing

The cleanup proceeds in phases. Each phase's completion is the gate for the
next; this is to prevent partial states where some PRs see one storage layer
or one tier layout and other PRs see another.

### Phase 0 — Contract publication

PR #774 (this document + `portability-harness-contract.md`) lands on develop.
Issue #768 receives the hybrid-resolution comment. Issues #775–#780 are filed.
Tier labels (`tier:core`, `tier:pilot`) are created.

### Phase 1 — Standalone fixes + boundary plumbing

In parallel:

- Merge #767, #773 (retarget first), #771, #742.
- Land **boundary plumbing**: `dependency-cruiser` config, two-stage CI
  workflow, `tier:core` / `tier:pilot` labels, empty `src/core/` and
  `src/pilot/` directories, `--pilot` flag scaffolding (lazy bootstrap, no
  pilot tools registered yet). File the four new core tool issues from §"New
  tools" above.
- Backfill tier labels on #698–#734 per the table in §7 of issue #768.
- Update #780 meta tracker after each merge.

**Gate** before proceeding: develop CI green; `--pilot` flag wired but
registers nothing; lint forbids `src/core/ → src/pilot/` imports.

### Phase 2a — Close-or-rebase decisions on the M1/M2 stack

The M1 + M2 stack is 22 PRs deep. Each PR is touched once:

- M1 PRs that become **MERGE → core**: #736, #737, #740, #743–#747 — close the
  original, open a new PR retargeted to `develop` with the same code under
  `src/core/<subdir>/`.
- M1 PRs that become **REROUTE → pilot** or **SPLIT**: #739, #741 — same flow
  but into `src/pilot/`.
- M1 PRs that become **CLOSE-REWRITE**: #735, #738 — close, write replacement
  PRs in Phase 3.

For each closed M1 PR, append a comment that lists the Codex P1/P2 findings
already resolved on that branch (provenance preserved for the replacement
reviewer).

### Phase 2b — M2 cherry-pick to develop

Strictly serial within this phase:

1. Merge #752 (already on `develop`). Canonical `phash.ts` lands.
2. Cherry-pick #748 → new PR → MERGE → `src/core/contracts/`.
3. Cherry-pick #749 → new PR → REROUTE → `src/pilot/runtime/`.
4. Cherry-pick #750 → new PR → REROUTE → `src/pilot/runtime/`.
5. Cherry-pick #751 → new PR → MERGE → `src/core/contracts/` (decoupled
   `oc_evidence_bundle`).
6. Cherry-pick #753 → new PR → MERGE-RECONCILE → `src/core/contracts/` (phash
   reconciliation).
7. Cherry-pick #754 → new PR → REROUTE → `src/pilot/handoff/`.
8. Cherry-pick #755 → new PR → REROUTE → `src/pilot/handoff/` (with key
   policy documented in body).
9. Cherry-pick #756 → new PR → REROUTE → `src/pilot/runtime/`.

After each merge, close the corresponding old stacked PR with:
*"Superseded by #NNN (retargeted to develop and routed to <tier> per the
hybrid plan in `openchrome-1.11-cleanup.md`)."*

### Phase 3 — Storage rewrites

Three independent replacement PRs against `develop`, all using
`src/utils/atomic-file.ts` + `proper-lockfile`:

- New trace storage replacing #735 → `src/core/trace/storage.ts` (JSONL only;
  session index = filesystem scan).
- New skill graph storage replacing #738 → `src/core/skill/storage.ts`
  (JSON-per-domain with per-domain lockfile).
- New skill-memory store replacing #762's storage half → `src/core/skill-memory/store.ts`
  (JSON-per-domain).

These three carry forward the credential redactor (#735), the
`to_state_distribution` schema (#738), and the frozen-snapshot scheme (#762)
without their SQLite backing.

### Phase 4 — Upper-stack moves into pilot

After Phase 3 storage lands:

- M1: #739 (graph executor) reopens against develop, files in `src/pilot/executor/`.
  #741 splits as described.
- M4: #761, #763, #764 reopen against develop, files in `src/pilot/curator/`.
  Recall ranking from the #762 split lands as `src/pilot/curator/recall.ts`.
- M4: #766 reopens against develop, files in `src/core/skill-memory/`.

### Phase 5 — Perception entrypoints

- #757, #758 reopen against develop → MERGE → `src/core/perception/`.
- #759 reopens against develop → REROUTE → `src/pilot/voting/` with the body
  reframe and deterministic voter test.

### Phase 6 — Out-of-scope close-and-move

- #760 closed with redirect to #775. Branch preserved for the separate package.
- #765 closed with redirect to #776. Branch preserved for the separate package.

### Phase 7 — Release wiring

- CHANGELOG entry for v1.11.0: core tier complete, pilot stub present, pilot
  not yet experimental.
- Tag and ship v1.11.0.
- Open the v1.12.0 milestone tracking pilot-experimental landings.

---

## Acceptance

This cleanup is complete when:

- every row in the per-PR table has reached its terminal state (merged with
  directory move, rerouted to pilot, rewritten without SQLite, or closed with
  separate-package redirect);
- `develop` builds, lints (including the dependency-cruiser core↛pilot rule),
  and the full test suite passes;
- `tools/list` and `resources/list` against the resulting build, with `--pilot`
  unset, return the 1.10.4 surface bit-identically, plus the four core-tier
  additions documented above;
- `tools/list` with `--pilot --pilot-features=trace,state_graph,runtime,
  handoff,perception_pilot,skill_curator` registers the rerouted pilot tools
  and prints a startup line listing them;
- the contract checklist in `portability-harness-contract.md` is verifiably
  satisfied by every PR that landed during the cleanup;
- issues #768 (resolved), #770 (auto-closed by #771), #772 (auto-closed by #773),
  #721 (closed with P3 redirect), #734 (closed or moved host-side) are
  terminal;
- audit-followup issues #687, #690 (and #684 if not auto-closed by #696)
  remain on their own track, unaffected by this cleanup.

After completion, this document is moved to `docs/roadmap/history/` and
referenced from the v1.11.0 release note. The contract document remains.
