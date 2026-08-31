# Project Structure

This document is the canonical map for OpenChrome's repository layout. Keep
README files focused on user workflows; put contributor-facing ownership and
folder-boundary decisions here.

## Top-Level Layout

| Path | Owner | Rule |
| --- | --- | --- |
| `src/` | shipped TypeScript runtime | Production code only. Tests, generated reports, and benchmark datasets stay out. |
| `cli/` | CLI entrypoints and command adapters | Thin command surfaces that call runtime modules. Do not duplicate domain logic here. |
| `tests/` | Jest, e2e, fixtures, integration checks | Mirror `src/` where practical. Test-only harnesses may live under `tests/benchmark` or `tests/e2e`. |
| `docs/` | user and contributor documentation | One canonical page per concept; README links to docs instead of copying details. |
| `benchmark/` | retained benchmark definitions and reports | Local generated outputs must be ignored unless they are intentionally curated evidence. |
| `scripts/` | maintenance and generation scripts | Scripts should either update tracked artifacts deterministically or write to ignored output paths. |
| `deploy/` | deployment examples | Keep Docker, systemd, and process-manager examples here. |
| `native-host/` | browser native-messaging host assets | Manifests and host implementation for native messaging. |
| `assets/` | published static assets | Small stable assets included in package output. |

## Runtime Module Boundaries

| Path | Responsibility |
| --- | --- |
| `src/core/` | domain primitives shared by runtime features: lifecycle, contracts, output, metrics, tracing, crawl, task-run, and task-ledger. |
| `src/tools/` | MCP tool implementations and tool-local helpers. Tool code may call `src/core`, but core code should not import tools. |
| `src/transports/` | MCP/HTTP transport surfaces and protocol adapters. |
| `src/chrome/`, `src/cdp/`, `src/browser-state/` | Chrome process, CDP, and browser state integration. |
| `src/session/`, `src/session-manager.ts` | session ownership, lease, and lifecycle coordination. New session code should prefer the `src/session/` folder. |
| `src/router/` | routing browser/tool commands to the correct target or tab. |
| `src/pilot/` | higher-level agent runtime features: skills, handoff, voting, credentials, curator, and automation runtime. |
| `src/hints/`, `src/recovery/`, `src/failure/` | guidance, recovery, and failure classification. |
| `src/vision/`, `src/perception`-related core modules | visual and perception-oriented processing. |
| `src/utils/` | cross-cutting leaf utilities only. If a utility gains domain ownership, move it into the owning module. |

## Test Layout

- Mirror production ownership when possible: `src/core/task-run/*` maps to
  `tests/core/task-run/*`.
- Put browser-level scenario tests under `tests/e2e/`.
- Put external integration adapters under `tests/external/`.
- Keep benchmark harness tests under `tests/benchmark/`, but do not put
  gated external datasets, third-party runner checkouts, or environment-specific
  result snapshots in the repo.
- Shared test fixtures belong under `tests/fixtures/`; feature-local fixtures
  stay next to their owning test group.

## Artifact Policy

- `dist/`, `coverage/`, runtime state, local browser profiles, logs, `run_data/`,
  and tool caches are local outputs and must remain ignored.
- `benchmark/results/` may contain curated reports. Generated preflight output
  should be reproducible and ignored unless a reviewer intentionally promotes it.
- Private evidence, screenshots, traces, decrypted task text, and API-key-derived
  outputs must not be committed.
- Generated docs must have a check command when they are committed.

## Current Cleanup Backlog

Use this order for future structure work:

1. Collapse duplicate ownership only after import graph inspection.
2. Clarify `src/extraction` versus `src/core/extract`.
3. Clarify `src/metrics` versus `src/core/metrics`.
4. Clarify `src/security` versus `src/core/secrets`.
5. Clarify `src/harness`, `src/run-harness`, and `tests/harness`.
6. Clarify `src/pilot/skill`, `src/core/skill`, and `src/resources/skill-graph`.
7. Move any remaining single-file root modules into their owning folder when the
   import surface is small and tests can prove the move.
