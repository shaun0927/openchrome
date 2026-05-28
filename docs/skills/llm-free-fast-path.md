# LLM-free skill fast path

> Recall → contract precheck → deterministic replay, with no model call.
> See issues #1430, #856 (oc_skill_replay), #1253 (replay codegen).

When a host agent has previously recorded a skill under
[`oc_skill_record`](../mcp/tool-annotations.md) with replay artifacts
emitted by the `--codegen` pipeline (#1253), subsequent task runs can
skip the LLM round entirely on contract match. The flow is:

1. **Recall** — call `oc_skill_recall` scoped to the current domain (and
   contract id, if known). The response includes each candidate skill's
   `codegenArtifacts: { kind, path, created_at }[]` pointing at
   replay-capable files written next to the skill store.
2. **Contract precheck** — call `oc_assert` against the candidate
   skill's `contractId`. If the contract holds against the current page
   state, the recorded steps are still valid and the LLM is not needed
   to rediscover them.
3. **Deterministic replay** — call `oc_skill_replay` with the
   `skill_id` from the recalled record. Replay is gated on
   `OPENCHROME_SKILL_REPLAY=1` and the `--pilot` flag (#856). It walks
   the recorded CDP steps, then re-evaluates the contract as the
   PASS gate. No retries, no DOM heuristics, no LLM.

If any step fails or the contract no longer holds, the host falls back
to the normal LLM-driven flow. The failed replay marks the skill via
`lastReplayFailedAt`, which `oc_skill_recall` re-uses to demote it on
the next recall (#856 invariant #4).

## Why the artifact pointers matter

The `codegenArtifacts` payload lets a host that does **not** want to
invoke `oc_skill_replay` (e.g. a Codex-side runtime that prefers a
Playwright script) still pick up the same recorded steps. Each
pointer carries:

- `kind`: `puppeteer` | `playwright` | `mcp-replay`.
- `path`: relative to the SkillMemoryStore root for portability across
  machines (per the SSOT #1359 "portable local artifacts" principle).
- `created_at`: wall-clock ms epoch.

A host should treat `codegenArtifacts: []` as "no replay surface
available, must use LLM".

## Gating

- The artifact pointers are persisted at `oc_skill_record` time only
  when `OPENCHROME_CODEGEN` (or `--codegen`) is enabled. When codegen
  is off, the field is written as `[]`.
- `oc_skill_replay` itself is double-gated by `--pilot` and
  `OPENCHROME_SKILL_REPLAY=1`. The recall response always surfaces the
  pointers; whether a host actually replays is its own decision.

## Operator checklist

1. Recorded skills carry `codegenArtifacts` after a record run with
   `OPENCHROME_CODEGEN=mcp-replay` (or `playwright` / `puppeteer`).
2. `oc_skill_recall` returns the same array on the response.
3. If the host opts into the fast path, an `oc_assert` precheck against
   the recorded `contractId` should be cheap (deterministic, no LLM).
4. On contract match, `oc_skill_replay` runs the recorded steps and
   reports PASS / STEP_FAIL / CONTRACT_FAIL / PRECONDITION_FAIL.

This loop is what enables the Webwright-style "Qwen-3.5-9B with 5+
reusable tools" pattern referenced in issue #1430 — small models
succeed when the harness can replay vetted, contract-bound recordings
without re-reasoning from scratch.
