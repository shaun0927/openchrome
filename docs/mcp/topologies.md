# OpenChrome MCP topologies

OpenChrome currently supports one safe direct-controller rule:

> Run at most one direct `openchrome serve --auto-launch` process for the same Chrome debug port and user-data directory.

Multiple MCP clients can still run in parallel today, but each direct OpenChrome process should use an explicit isolated Chrome topology until broker mode is available.

## Single-owner default

Use this when one MCP client owns OpenChrome on the default Chrome port/profile.

```bash
openchrome config --client codex
openchrome config --client claude
```

Generated configs use:

```bash
openchrome serve --auto-launch
```

Do not install this same direct config in multiple clients at the same time.

## Isolated per-client profiles

Use a different port and user-data directory for each client:

```bash
openchrome setup --client codex --port 9223 --user-data-dir ~/.openchrome/profiles/codex
openchrome setup --client claude --port 9224 --user-data-dir ~/.openchrome/profiles/claude
openchrome setup --client opencode --port 9225 --user-data-dir ~/.openchrome/profiles/opencode
```

Or use the built-in isolated preset as a starting point:

```bash
openchrome config --client codex --topology isolated
```

## CI/headless and development presets

For reproducible automation, prefer an isolated throwaway profile:

```bash
openchrome config --client codex --topology ci-headless
```

For local development, use a named development profile:

```bash
openchrome config --client claude --topology dev-profile
```

## Future broker topology

The planned broker topology will allow many MCP clients to share one direct Chrome owner. Until that exists, direct shared-profile multi-client setups should be treated as unsafe because independent processes can race over CDP target lifecycle, reconnect, and cleanup.
