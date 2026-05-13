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

This is the engine-level fallback hook. Tool-level callers can wire a
`PerceptionSnapshot` from `vision_find` or an optional provider in follow-up
integration without changing the deterministic safety gates.
