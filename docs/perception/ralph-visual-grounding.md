# Ralph visual grounding fallback

Ralph keeps DOM/AX/CDP strategies first. Visual grounding is an opt-in fallback
that can run after `S6_CDP_RAW` and before HITL when a caller supplies a
provider-neutral `PerceptionSnapshot`.

## Strategy order

```text
S1_AX -> S2_CSS -> S3_CDP_COORD -> S4_JS_INJECT -> S5_KEYBOARD -> S6_CDP_RAW -> S7_VISUAL_GROUNDING -> S8_HITL
```

`S7_VISUAL_GROUNDING` is skipped unless both `visualGrounding: true` and
`visualSnapshot` are present in `RalphOptions`.

## Safety gates

- Only `click`, `double_click`, and `hover` are eligible.
- Candidate must be interactive and have a credible bounding box.
- Deterministic label/role token score must pass the threshold.
- The top candidate must have a clear margin over the second candidate.
- Unsafe visual-only labels such as delete, pay, transfer, password, MFA, or
  secrets are skipped and Ralph escalates to HITL.

## Evidence

When the visual fallback succeeds, the normal Ralph response includes:

- `strategyUsed: "S7_VISUAL_GROUNDING"`
- `strategiesTried` containing the visual strategy
- a response line that names the visual provider and deterministic score

## Current boundary

Ralph retains the engine-level fallback hook and deterministic candidate score.
For a caller that has already selected an exact element, `interact
mode="perception"` provides the direct tool-level path:

```text
vision_find format="snapshot"
  -> host selects one snapshot element ID
  -> interact mode="perception"
  -> OpenChrome validates provenance and dispatches one action
```

These paths have different ownership boundaries:

- Ralph visual grounding deterministically matches a requested label against
  snapshot candidates as a late fallback.
- `interact mode="perception"` never selects or ranks candidates. It consumes
  the exact snapshot-local ID chosen by the MCP host.

Both paths keep DOM/AX/CDP authority first when durable browser identity is
available, reject unsafe visual-only targets, and add no server-side model or
provider dependency.
