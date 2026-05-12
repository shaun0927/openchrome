# tests/pilot/

Tests for modules under `src/pilot/**`. Per the portability-harness contract
(`docs/roadmap/portability-harness-contract.md`), pilot-tier code is opt-in via
the `--pilot` CLI flag and must satisfy:

- **P2**: bit-identical 1.10.4 behavior when `--pilot` is unset.
- **P3**: no outbound LLM API egress, no mandatory third-party credentials.
- **P5**: no native dependency without graceful fallback.

P1 and P4 are relaxed for pilot (it may run background work and encode workflow
policy).

## Scope

- Tests for any module living under `src/pilot/**`.
- Tests verifying that pilot tools are not registered when `--pilot` is unset.
- Tests for pilot-specific behavior (retry, escalation, irreversible-action
  confirmation, handoff persistence, structural curator, deterministic voters).

## Two-stage CI

The CI workflow runs this directory's tests on every PR for now. Once the
`src/pilot/**` source modules have content (Phase 2b/4 of the 1.11 cleanup),
this directory will graduate to a path-filtered job that only runs when
`src/pilot/**` or `tests/pilot/**` is touched.

Migration plan:

1. **Now** (this PR): scaffold `tests/pilot/` with this README. Full suite
   still runs on every PR.
2. **After Phase 4** (pilot reroute PRs merge): split jest config so that
   `tests/pilot/` runs only when pilot files change. The CI workflow gets a
   second job gated by `paths: ['src/pilot/**', 'tests/pilot/**']`.

## Running

To run only the pilot-tier slice:

```bash
npx jest tests/pilot
```

Pilot tests should construct the server with `--pilot` set in their setup;
core-tier tests should assert that `--pilot` is unset and that pilot modules
are not loaded.
