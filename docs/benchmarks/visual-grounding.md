# Visual grounding benchmark

This CI-safe harness covers the OmniParser adoption E verification lane without
requiring a GPU or real OmniParser in CI. It produces the report shape expected
by the live verification checklist and validates whether visual grounding helps
without wrong clicks, wandering, or unbounded memory growth.

## Scenarios

1. `dom-ax-normal` — ordinary DOM/AX control succeeds without visual provider.
2. `poor-label-visual` — visible label drives visual fallback.
3. `canvas-visual-only` — visual-only target uses `S7_VISUAL_GROUNDING`.
4. `ambiguous-visual` — ambiguous candidates are blocked/rejected.
5. `unsafe-visual-target` — destructive-looking visual target is blocked.
6. `provider-timeout` — provider failure falls back to DOM/default path.
7. `long-running-soak` — repeated cycles keep memory growth bounded.

## Run

```bash
npm run build
node scripts/bench/visual-grounding/run.mjs \
  --openchrome-command "node dist/index.js --http 9897" \
  --fixture-port 9997 \
  --mock-omniparser-port 9907 \
  --out scripts/verify/omniparser-adoption-E-visual-bench/report.json \
  --record-artifacts scripts/verify/omniparser-adoption-E-visual-bench/artifacts
```

The current runner is deterministic/mock-backed for CI and accepts the live MCP
command-line shape so maintainers can replace mock calls with real MCP calls
without changing the report contract.

## Required checks

```bash
REPORT=scripts/verify/omniparser-adoption-E-visual-bench/report.json
jq -e '.summary.pass == true' "$REPORT" >/dev/null
jq -e 'all(.scenarios[]; .wrongClicks == 0)' "$REPORT" >/dev/null
jq -e 'any(.scenarios[]; .name == "canvas-visual-only" and .success == true and .strategyUsed == "S7_VISUAL_GROUNDING")' "$REPORT" >/dev/null
jq -e 'any(.scenarios[]; .name == "ambiguous-visual" and .success == true and (.strategyUsed | test("HITL|blocked|rejected")))' "$REPORT" >/dev/null
jq -e 'any(.scenarios[]; .name == "provider-timeout" and .success == true and (.provider | test("fallback|dom")))' "$REPORT" >/dev/null
jq -e 'any(.scenarios[]; .name == "long-running-soak" and .success == true and (.health.memoryGrowthMb <= 75))' "$REPORT" >/dev/null
```
