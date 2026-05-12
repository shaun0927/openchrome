# tests/core/

Tests for modules under `src/core/**`. Per the portability-harness contract
(`docs/roadmap/portability-harness-contract.md`), the two-stage CI requires
this directory's tests to pass on **every** PR regardless of which tier the PR
touches.

## Scope

- Tests for any module living under `src/core/**`.
- Tests verifying P1–P5 contract invariants (e.g., "with `--pilot` unset, no
  module from `src/pilot/**` is loaded").

## Migration status (1.11 cleanup)

The existing test directory at `tests/` predates the tier split. Tests there
remain in place and continue to run on every PR. As the 1.11 cleanup PRs land,
new tests for `src/core/**` modules go directly into `tests/core/<subdir>/`.
A separate consolidation PR (post-cleanup) will migrate the existing
`tests/<subdir>/` files into `tests/core/<subdir>/` once the corresponding
source modules have all relocated to `src/core/<subdir>/`.

## Running

The CI workflow runs the full Jest suite. To run only the core-tier slice:

```bash
npx jest tests/core
```

Locally, the dependency-cruiser rule (`npm run lint:tier`) guards against
`src/core/**` modules importing from `src/pilot/**`. Tests that violate this
boundary also fail to compile.
