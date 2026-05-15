# Reliability benchmark direction for #1259

## Decision

The credible headline for #1259 should be **complex real-world task completion**.
Fault recovery remains part of the reliability axis, but it is a secondary stress
mode layered onto realistic tasks, not the primary product claim by itself.

## Why the direction changes

The existing isolated fault matrix is useful for engineering diagnostics, but it
can answer only a narrow question: whether a library survives a synthetic fault
cell. Users and reviewers care first about whether the library can finish a
realistic workflow end-to-end, repeatedly, with a contract-backed result.

Therefore published #1259 claims should be ordered as:

1. **Primary:** real-world task success rate across task categories, libraries,
   and repetitions.
2. **Secondary:** fault-recovery stress rate when first-principles faults are
   injected at deterministic checkpoints inside those real tasks.
3. **Guardrails:** isolated flaky-rate cells, long-run resource stability, and
   cross-platform pass rate.

## Required task taxonomy

The initial real-world reliability suite should include at least one controlled
fixture per category:

- search → filter → detail extraction
- auth/session workflow
- modal or cookie-banner handling
- multi-page comparison
- SPA async navigation
- form submit plus validation

Public-web tasks can remain useful, but they should not be the only evidence
because site drift makes reliability claims hard to reproduce.

## Metrics

For each `library × task × repetition` row:

- final contract status: `passed`, `failed`, `partial`, `timeout`, `tool_error`,
  `adapter_error`
- time-to-complete
- tool/step count
- retry count or recovery count
- no-progress episodes
- failure reason taxonomy
- execution mode: native agent loop vs passive wrapper
- sample count and whether the row is publishable

For each stress-mode row:

- injected fault type
- deterministic injection checkpoint
- final task postcondition after the fault
- steps-to-recover
- time-to-recover
- explicit skip reason when a live adapter is unavailable

## Publication rules

- Mock or scaffold rows are never measured competitive results.
- Live-unwired skip rows must use null numeric metrics, not zeroes.
- Primary reliability claims must cite real-world task completion rows.
- Isolated fault cells may support diagnostics but cannot replace task-level
  success evidence.
- Native and passive-wrapper modes must be reported separately.

## Follow-up issues created

- #1304 — real-world task completion as the primary reliability signal
- #1303 — inject reliability faults inside real-world tasks

## This PR's implementation scope

This PR does not fabricate live benchmark numbers. It adds methodology guardrails
so existing mock/scaffold reliability rows are explicitly marked as non-publishable
and records the new #1259 measurement direction in code plus documentation.
