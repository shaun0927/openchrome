# OpenChrome Architecture

OpenChrome is one npm package with two runtime surfaces:

- `openchrome` / `oc`: CLI commands and MCP host setup helpers.
- `openchrome serve`: MCP server over stdio, HTTP, or both.

The repository intentionally carries only the CLI/MCP runtime, its tests, and
durable documentation. Desktop apps, browser extensions, native-host installers,
deployment templates, release artifact builders, historical roadmaps, and
one-off validation transcripts are out of scope.

## Runtime Layers

| Layer | Path | Responsibility |
| --- | --- | --- |
| CLI adapters | `cli/` | Parse commands, generate host config, and forward serve/runtime calls. |
| MCP server | `src/mcp/` | JSON-RPC request handling, tool dispatch, and output accounting. |
| Transports | `src/transports/` | stdio and Streamable HTTP protocol adapters. |
| Browser control | `src/chrome/`, `src/cdp/`, `src/session/`, `src/router/` | Chrome launch/attach, CDP connection, session ownership, and tab routing. |
| Tool surface | `src/tools/` | MCP tool implementations. |
| Core primitives | `src/core/` | Shared storage, contracts, output handles, tracing, extraction, perception, metrics, and lifecycle utilities. |
| Policy and safety | `src/security/`, `src/auth/`, `src/config/` | Runtime policy, auth, secret loading, redaction, and audit adapters. |
| Pilot tier | `src/pilot/` | Optional recovery, handoff, voting, and skill runtime behind `--pilot`. |

## Import Boundary

Core code must not import pilot code. The dependency-cruiser rule in
`.dependency-cruiser.cjs` enforces this:

- `src/core/**` must not import from `src/pilot/**`.
- `src/pilot/**` may import from `src/core/**`.

Run:

```bash
npm run lint:tier
```

## Agent Loop

```
MCP host agent
   |
   | JSON-RPC over stdio or HTTP
   v
openchrome-mcp
   |
   | tool dispatch
   v
Chrome/CDP controller
   |
   v
real Chrome profile or isolated Chrome profile
```

The host agent decides what to do. OpenChrome captures browser facts, executes
tool calls, and returns structured results. The server does not call external
LLM APIs.

## Storage

Runtime state is local and ignored by Git. Common paths include:

- `~/.openchrome/` for user-level runtime state.
- `.openchrome/` for project-local runtime state when configured.
- `dist/`, `coverage/`, `artifacts/`, `.omx/`, `.omc/`, and `.omo/` for build,
  test, or agent-local outputs.

Tracked runtime policy lives in `config/`.

## Related Docs

- [`docs/getting-started.md`](getting-started.md)
- [`docs/getting-started/http-daemon.md`](getting-started/http-daemon.md)
- [`docs/cli.md`](cli.md)
- [`docs/cli/playbook.md`](cli/playbook.md)
- [`docs/mcp/topologies.md`](mcp/topologies.md)
- [`docs/dev/project-structure.md`](dev/project-structure.md)
