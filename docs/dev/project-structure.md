# Project Structure

This document is the canonical map for OpenChrome's repository layout. Keep
README files focused on user workflows; put contributor-facing ownership and
folder-boundary decisions here.

## Top-Level Layout

| Path | Owner | Rule |
| --- | --- | --- |
| `src/` | shipped TypeScript runtime | Production code only. Tests, generated reports, and public scoring data stay out. |
| `cli/` | CLI entrypoints and command adapters | Thin command surfaces that call runtime modules. Do not duplicate domain logic here. |
| `tests/` | Jest, e2e, fixtures, integration checks | Mirror `src/` where practical. Browser-level scenario tests live under `tests/e2e`. |
| `docs/` | user and contributor documentation | One canonical page per concept; README links to docs instead of copying details. |
| `scripts/` | maintenance and generation scripts | Scripts should either update tracked artifacts deterministically or write to ignored output paths. |
| `deploy/` | deployment examples | Keep Docker, systemd, and process-manager examples here. |
| `native-host/` | browser native-messaging host assets | Manifests and host implementation for native messaging. |
| `assets/` | published static assets | Small stable assets included in package output. |
| `config/` | shipped runtime policy config | Package-facing configuration consumed by runtime code. Local overrides stay ignored. |
| `extension/` | browser extension package | Extension source and manifest files only. |
| `desktop/` | Tauri desktop app | Desktop application code and app-specific build assets. |
| `commands/` | plugin slash commands | Published host-plugin commands. Keep command logic as short routing instructions. |
| `skills/` | plugin skill bodies | Published host-plugin skills. Shared skill content lives here, not inside host-specific manifests. |
| `.claude-plugin/`, `.codex-plugin/` | host plugin manifests | Thin package manifests only. They point at shared `skills/` and `commands/` content. |

## Allowed Root Entries

The repository root should stay small. A root entry is allowed only when it is
one of these package or toolchain surfaces:

- standard project documents (`README.md`, `LICENSE`, `SECURITY.md`,
  `CONTRIBUTING.md`, `CHANGELOG.md`);
- package and compiler configuration (`package.json`, lockfile, TypeScript,
  Jest, ESLint, dependency-cruiser, webpack);
- container and deployment entrypoints (`Dockerfile`, `.dockerignore`);
- GitHub automation (`.github/`);
- publish surfaces declared in `package.json#files`;
- first-level source, test, docs, script, app, extension, and deployment
  directories listed in the table above.

Do not add ad hoc root folders for experiments, generated reports, worktrees,
agent-local state, or one-off validation outputs. Put durable contributor
documentation under `docs/`, runnable maintenance code under `scripts/`, and
ignored local outputs under paths covered by `.gitignore`.
`npm run lint:repo-structure` enforces the current `src/` root entry allow-list,
the approved `src/utils` leaf allow-list, the approved `tests/utils` shared
helper allow-list, and prevents reintroducing the deprecated `tests/src` bucket.

## Package Publish Surface

`package.json#files` is the canonical allow-list for project-owned npm package
content. npm also includes standard metadata such as `package.json`, README
files, and `LICENSE`. As of this document, the package intentionally publishes:

- `dist/` compiled runtime and CLI entrypoints;
- `assets/` stable package assets;
- `config/` shipped runtime policy configuration;
- README files, `LICENSE`, and `docs/agent/capability-map.md`;
- `skills/`, `commands/`, `.claude-plugin/`, and `.codex-plugin/` for host
  plugin discovery.

The host-specific manifests must stay thin. Shared skill and command content
belongs in `skills/` and `commands/`; do not fork equivalent copies under
`.claude-plugin/` or `.codex-plugin/`.

## Runtime Module Boundaries

| Path | Responsibility |
| --- | --- |
| `src/core/` | domain primitives shared by runtime features: lifecycle, process liveness, request-scoped observability context, contracts, output, metrics collection and token estimates, tracing, crawl, deadline handling, filesystem persistence, secret loading/redaction/substitution, task-run, and task-ledger. |
| `src/tools/` | MCP tool implementations and tool-local helpers. Tool code may call `src/core`, but core code should not import tools. |
| `src/mcp/` | MCP server implementation, protocol ingress helpers, session-init policy, and MCP output accounting. `src/mcp-server.ts` is a compatibility re-export for existing imports. |
| `src/transports/` | MCP/HTTP transport surfaces and protocol adapters. |
| `src/chrome/`, `src/cdp/`, `src/browser-state/` | Chrome process, PID/guardian cleanup, controller ownership, CDP, and browser state integration. |
| `src/dom/` | DOM serialization, element discovery, AX resolution, shadow DOM traversal, and DOM-change feedback. |
| `src/extraction/` | `extract_data` schema validation, extraction mode planning, semantic host payloads, and browser-side strategy script generation. Shared HTML-to-markdown and content filtering primitives live under `src/core/extract`. |
| `src/session/` | session ownership, lease, snapshot, and lifecycle coordination. `src/session-manager.ts` is a compatibility re-export for existing imports; new code should import from `src/session/manager` or the nearest package entrypoint. |
| `src/router/` | routing browser/tool commands to the correct target or tab. |
| `src/observability/` | logging, redaction, and visual trajectory adapters. Request context lives under `src/core/observability` because metrics, security, transports, resources, and tools all share it. |
| `src/security/` | runtime policy and untrusted-boundary enforcement: domain allow/block policy, MCP root narrowing, tool risk gates, audit logging adapters, and prompt-injection content sanitization. Secret value mechanics stay under `src/core/secrets`; `src/security` may use core primitives, but `src/core` must not import security policy adapters. |
| `src/pilot/` | higher-level agent runtime features: skills, handoff, voting, credentials, curator, and automation runtime. |
| `src/hints/`, `src/recovery/`, `src/failure/` | guidance, recovery, and failure classification. |
| `src/vision/`, `src/perception`-related core modules | visual and perception-oriented processing. |
| `src/utils/` | approved cross-cutting leaf utilities only: formatting, logging, retry fallback, listener safety, and URL helpers. No subdirectories or stateful domain services. |

## Test Layout

- Mirror production ownership when possible: `src/core/task-run/*` maps to
  `tests/core/task-run/*`.
- Put browser-level scenario tests under `tests/e2e/`.
- Put external integration adapters under `tests/external/`.
- Keep public scoring harnesses, third-party runner checkouts, external
  datasets, and generated result snapshots out of the product repository.
- Shared test fixtures belong under `tests/fixtures/`; feature-local fixtures
  stay next to their owning test group.

## Artifact Policy

- `dist/`, `coverage/`, runtime state, local browser profiles, logs, `run_data/`,
  and tool caches are local outputs and must remain ignored.
- Public scoring reports and generated comparison outputs do not belong in
  this repository.
- Private evidence, screenshots, traces, decrypted task text, and API-key-derived
  outputs must not be committed.
- Generated docs must have a check command when they are committed.

## Current Cleanup Backlog

Use this order for future structure work:

1. Collapse duplicate ownership only after import graph inspection.
2. Clarify `src/harness`, `src/run-harness`, and `tests/harness`.
3. Clarify `src/pilot/skill`, `src/core/skill`, and `src/resources/skill-graph`.
4. Move any remaining single-file root modules into their owning folder when the
   import surface is small and tests can prove the move.
