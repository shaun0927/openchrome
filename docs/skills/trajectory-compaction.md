# Trajectory compaction with `oc_journal_compact`

> Recommended cadence and integration patterns for using
> `oc_journal_compact` to keep host-side context windows bounded on
> long-horizon tasks. See #1434.

`oc_journal_compact` compresses a sliding window of journal entries
into a model-friendly summary. It is the OpenChrome surface for the
problem Webwright describes as "context explosion" (Microsoft Research,
2026-05): long coding/browsing trajectories blow past context limits
within tens of tool calls.

## When to compact

The cadence reported in Webwright's blog post is **every 20 steps**.
The table below is a *suggested* cadence derived from that report —
`oc_journal_compact` enforces nothing, so these are host-side
guidelines, not tool behaviour. OpenChrome has not independently
re-measured these numbers (per #1359 P5 they stay attributed to
Webwright rather than presented as OpenChrome benchmark claims):

| Trajectory length      | Recommended cadence | Strategy           |
|------------------------|---------------------|--------------------|
| 1–20 tool calls        | None — keep raw     | n/a                |
| 20–100 tool calls      | Every 20 steps      | `recent_k`         |
| 100+ tool calls        | Every 50 steps      | `recent_k` + `checkpoint_only` snapshot |
| Multi-session resume   | At resume           | `checkpoint_only`  |

The lower bound (20) matches Webwright. The upper bound (50) is also
theirs — the reported observation that "the next 50 steps deliver only
3–4 additional accuracy points" on Online-Mind2Web — suggesting that
beyond that point the marginal cost of carrying the raw trajectory
tends to exceed the marginal benefit, so compaction pays off more
often. These remain Webwright's figures, not OpenChrome measurements.

## Picking a strategy

- **`recent_k`** (default, deterministic): concatenates summaries of
  the last K entries truncated to `token_budget`. Use when the host
  needs continuity of recent tool calls but wants to drop early
  exploration noise. Tokens are estimated with a `~4 chars / token`
  heuristic (same as `src/mcp/output-observability.ts`); it is
  deliberately imprecise — the goal is a stable, vendor-neutral budget,
  not a guarantee.
- **`checkpoint_only`** (deterministic): emits only milestone entries
  plus the last successful `oc_checkpoint`. Use at session boundaries
  or when the host has its own per-step reasoning and only needs anchor
  points.
- **`sampling`** (host-mediated): forwards a summarisation prompt to
  the host LLM via `sampling/createMessage`. Returns
  `{ status: "unsupported_by_host" }` when the client doesn't advertise
  the capability — OpenChrome never falls back to a server-side LLM
  (SSOT #1359). Use when the host wants narrative compression rather
  than mechanical truncation.

## Reading the output

Every successful call returns:

```jsonc
{
  "status": "ok",
  "summary": "...",                  // text body within token_budget
  "facts": [{ "ts", "tool", "ok", "summary", ... }],
  "open_assertions": [{ ... }],      // failed oc_assert calls
  "last_checkpoint": { ... },         // most recent oc_checkpoint pass
  "tokens_estimated": 487,
  "strategy_used": "recent_k"
}
```

The host SHOULD treat `open_assertions` as "work still owed" — these
are failed contract calls that have not yet been retired by a later
pass. Combined with `last_checkpoint`, a recovering session can resume
without re-deriving its current state from raw tool calls.

## Integration with the LLM-free fast path

`oc_journal_compact` and the LLM-free fast path
([docs/skills/llm-free-fast-path.md](./llm-free-fast-path.md)) compose
naturally: compaction drops the head of a long exploration into a
summary, then the next contract precheck can pick up a recorded skill
via `oc_skill_recall` and replay it deterministically. Together they
let a small model run long-horizon tasks without paying for either the
raw token bill or repeated LLM re-discovery.

## Verification

The integration test
`tests/tools/oc-journal-compact-roundtrip.test.ts` exercises a full
round-trip: a synthetic trajectory of 30 entries is compacted to
`recent_k`, the resulting summary is re-fed into a follow-up call, and
the open-assertion bookkeeping survives both passes. This pins the
contract that compaction is lossy-but-stable: facts may shrink, but
the set of unresolved assertions and the last checkpoint must not
change unless the underlying journal does.
