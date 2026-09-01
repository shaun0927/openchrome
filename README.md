# OpenChrome

OpenChrome is a browser automation MCP server for controlling a real Chrome
browser from Claude Code, Codex CLI, OpenCode, or any MCP client.

It ships as a Node CLI plus MCP runtime. Desktop apps, browser extensions,
native-host installers, deployment templates, and release artifact builders are
outside this repository surface.

## Install

```bash
npm install -g openchrome-mcp
openchrome setup --client codex
```

For Claude Code:

```bash
openchrome setup --client claude
```

Restart the MCP host after setup so it reloads the generated configuration.

## Run

```bash
openchrome serve --auto-launch --auto-elect --minimal
```

Manual Codex CLI configuration:

```bash
openchrome config --client codex
```

Add the printed `[mcp_servers.openchrome]` block to `~/.codex/config.toml`.

## CLI

OpenChrome can call its MCP tools directly from the shell:

```bash
oc run navigate --arg url=https://example.com
oc run read_page --arg mode=dom --json
oc navigate https://example.com
oc click ref_5
```

Playbooks run deterministic YAML scenarios:

```bash
oc playbook run scenario.yaml --vars url=https://iana.org --out report.md
```

## HTTP Mode

Run a long-lived MCP HTTP daemon when multiple clients should share one managed
Chrome owner:

```bash
openchrome serve --http 3100 --auth-token <token> --idle-timeout 30m
curl -s http://127.0.0.1:3100/health
```

Independent stdio clients should use separate `--port` and `--user-data-dir`
profiles, or connect through broker mode with `--auto-elect`.

## Capabilities

- Real Chrome control through CDP.
- Navigation, clicks, typing, screenshots, DOM reads, accessibility reads, and
  natural-language element lookup.
- Parallel tab/session workflows with broker-safe profile ownership.
- Compact page serialization for lower-token agent loops.
- Outcome contracts, evidence bundles, diffs, and diagnostics.
- Optional pilot-tier recovery and skill runtime behind `--pilot`.

Full tool catalogue: [`docs/agent/capability-map.md`](docs/agent/capability-map.md).

## Documentation

| Topic | Link |
| --- | --- |
| Architecture | [`docs/architecture.md`](docs/architecture.md) |
| Getting started | [`docs/getting-started.md`](docs/getting-started.md) |
| CLI | [`docs/cli.md`](docs/cli.md) |
| Playbooks | [`docs/cli/playbook.md`](docs/cli/playbook.md) |
| MCP topologies | [`docs/mcp/topologies.md`](docs/mcp/topologies.md) |
| HTTP daemon | [`docs/getting-started/http-daemon.md`](docs/getting-started/http-daemon.md) |
| Security model | [`SECURITY.md`](SECURITY.md) |
| Repository structure | [`docs/dev/project-structure.md`](docs/dev/project-structure.md) |

## Development

```bash
git clone https://github.com/shaun0927/openchrome.git
cd openchrome
npm install
npm run build
npm test
```

Useful checks:

```bash
npm run lint
npm run lint:repo-structure
npm run lint:tier
npm run docs:capability-map:check
```

## License

MIT
