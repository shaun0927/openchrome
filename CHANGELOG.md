# Changelog

All notable changes to OpenChrome are documented here. For full release notes see `docs/releases/`.

---

## v1.12.0 — task harness, recovery runtime, CLI MCP driver (2026-05-14)

Largest feature release in the v1.x line: 105 PRs, ~30 new MCP tools, a
goal-level task harness, a deterministic recovery/reflection runtime, a
CLI that drives the MCP surface directly (`oc run` / `oc playbook` /
`oc doctor` / `oc vault`), Streamable HTTP daemon mode, and 2 new MCP
resources. No source files removed; no new mandatory runtime deps.

See [`docs/releases/v1.12.0.md`](docs/releases/v1.12.0.md) for the full
release notes, including the six observable breaking changes and their
migration paths.

---

## v1.11.x

### Transport policy

A formal transport lifecycle policy has been established in
[`docs/transport-lifecycle.md`](docs/transport-lifecycle.md). The document
covers:

- The three supported transport modes (`stdio`, `http`, `both`) with stability
  status and recommended use cases.
- Stability commitments: message-shape compatibility, guaranteed notification
  types, and what minor versions are permitted to change.
- Deprecation policy: minimum 3 minor versions **or** 6 months overlap between
  announcement and removal, whichever is longer.
- Boot-time deprecation warning contract (implementation deferred to a follow-up
  code PR; no warning is emitted yet).
- Migration recipes: stdio → HTTP, and HTTP → Streamable HTTP (when #839 lands).

**No transport is currently deprecated.** All three transport modes remain
stable with no sunset date. This section will be updated when a transport is
first marked deprecated.

---

## v1.11.0 — portability-harness contract (2026-05-12)

See [`docs/releases/v1.11.0.md`](docs/releases/v1.11.0.md) for the full release
notes.

---

## Earlier releases

See the release notes in [`docs/releases/`](docs/releases/) for v1.10.x and
earlier.
