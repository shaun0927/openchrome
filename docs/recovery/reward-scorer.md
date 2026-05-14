# Recovery reward scorer

`src/recovery/reward-scorer.ts` is a pure deterministic scorer for recovery telemetry (#1019). It converts lightweight evidence into a bounded score from `-1` to `1` plus a classification, reasons, and confidence.

## Safety contract

- No LLM/API/provider calls.
- No browser actions, retries, or replay.
- No raw DOM/screenshot/network blobs are required.
- Same input must produce byte-identical output.
- Contract verdicts dominate heuristic evidence: pass is the strongest positive signal, fail is a strong negative reason.

## Intended consumers

- `MCPServer` recovery trajectory telemetry records the numeric reward for later inspection.
- #1018 candidate ranking may sort recovery candidates by this score.
- #1020 bounded recovery search may use scores as evidence, not as permission to execute.
- #1022 policy learning may aggregate scores, but the scorer itself remains stateless.

## Score bands

| Classification | Meaning |
| --- | --- |
| `contract_pass` | Outcome contract passed; strongest positive evidence. |
| `progress` | URL/DOM/network/data/ref evidence moved in the intended direction. |
| `observation` | Observation produced information but no strong progress signal. |
| `no_progress` | No meaningful delta or repeated observation without new evidence. |
| `failure` | Stale ref, timeout, missing element, target closed, or tool error. |
| `blocked` | Auth/CAPTCHA/access-denied/blocking-page signal. |
| `destructive_blocked` | Ungated destructive/transactional action; hard negative. |

The score is advisory telemetry. Hosts decide whether to retry, change strategy, ask the user, or stop.
