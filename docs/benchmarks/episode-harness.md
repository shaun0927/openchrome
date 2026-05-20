# Episode harness benchmark

The episode harness is a test/tooling layer for repeatable browser-task evaluation. It is intentionally outside production `src/**` behavior: no server-side LLM calls, no credentials, no autonomous runtime loop.

Each episode follows this shape:

1. normalize a task spec and hard caps,
2. reset browser state,
3. navigate to the task `startUrl`,
4. ask an adapter for deterministic tool calls,
5. evaluate the task's Outcome Contract assertion,
6. write JSONL events plus JSON/Markdown reports.

## Task authoring

Task specs use the existing Outcome Contract assertion vocabulary from `src/contracts/types.ts`:

```ts
{
  id: 'example-h1',
  title: 'Example H1 fixture',
  startUrl: 'mock://example',
  goal: 'Verify the heading.',
  maxSteps: 5,
  maxDurationMs: 30000,
  success: { kind: 'dom_text', selector: 'h1', contains: 'Example Domain' }
}
```

Caps are mandatory after defaults are applied: `maxSteps` defaults to 30 and is capped at 100; `maxDurationMs` defaults to 120 seconds and is capped at 600 seconds.

Public tasks must avoid login, payment, CAPTCHA, live prices, news/current dates, and user-specific state.

## Adapter boundary

`--adapter mock` is the default CI adapter and never calls an LLM provider. Real LLM adapters must remain opt-in and credential-gated. Adapters return one tool call at a time or `done`; the runner owns stop conditions and contract evaluation.

## Commands

```bash
npm run bench:episode:mock
npm run bench:episode -- --adapter mock --task example-h1 --out /tmp/openchrome-episode-harness
npm run bench:episode:mock -- --task local-recovery-stall --max-steps 2 --out /tmp/openchrome-stall
```

Outputs are written under the selected output directory:

- `report.json` / `report.md` aggregate suite reports,
- `events/<run-id>.jsonl` per-step event streams,
- `reports/<run-id>.json` / `.md` per-episode reports.

## Relation to WebVoyager benchmark work

Issue #1257 owns the Agent Task Success comparison. WebVoyager-style tasks remain the stable public-web lookup layer; this episode harness now owns the controlled realistic workflow foundation for stateful task success. The controlled layer emits task taxonomy, repeated samples, first-tool accuracy, no-progress signals, and deterministic full-task token estimates. This harness also owns the reusable episode substrate (`EpisodeTaskSpec`, `EpisodeResult`, reporter, stop conditions, and mock-adapter contract) that WebVoyager-style and future benchmark suites should reuse instead of duplicating runners. See `docs/benchmarks/agent-task-success.md`.

## Headline eligibility

The mock adapter is a CI smoke surface, not competitive evidence. Aggregate reports include a `claimEligibility` block with a tier and reason list. A suite is `primary-realworld` only when it is a live or recorded-real run, evaluates the final postcondition, pins competitor/library metadata, uses the same task contracts across compared libraries, and meets the sample threshold from [`benchmark-direction.md`](./benchmark-direction.md).

Current `--adapter mock` output is therefore expected to report `diagnostic-only`. That is correct: it proves harness behavior and prevents mock rows from being accidentally promoted into benchmark headline claims.
